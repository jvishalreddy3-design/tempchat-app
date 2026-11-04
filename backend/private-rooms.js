'use strict';

// Secure one-to-one temporary rooms.
//
// The module deliberately reuses the room registry, member tokens and chat
// relay that already exist in server.js. A private room is an ordinary room
// with `private: true`, exactly two authorized account ids and an invitation
// that can only be consumed by the invited account. It is never listed for
// public discovery and `join-request` refuses it.

const DEFAULT_INVITATION_TTL_MS = 10 * 60 * 1000;
const MAX_INVITATIONS = 500;
const MAX_PRIVATE_ROOMS = 250;
const CREATE_RATE_LIMIT = 20;
const CREATE_RATE_WINDOW_MS = 10 * 1000;

function isValidId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 160;
}

function isPrivateRoom(room) {
  return Boolean(room && room.private === true);
}

function installPrivateRooms(io, deps) {
  const {
    rooms,
    store,
    generateRoomCode,
    newToken,
    cleanName,
    broadcastUserList,
    closeRoom,
    leaveRoom,
    invitationTtlMs = DEFAULT_INVITATION_TTL_MS,
    now = Date.now
  } = deps;

  const invitations = new Map();   // invitationId -> invitation
  const invitationByPair = new Map(); // pairKey -> invitationId
  const pairQueues = new Map();    // pairKey -> tail promise (serializes create)
  const createRateLimits = new Map();

  function pairKey(a, b) {
    if (store && typeof store.pairKey === 'function') return store.pairKey(a, b);
    return [a, b].sort().join(':');
  }

  function accountSockets(accountId) {
    const result = [];
    for (const candidate of io.sockets.sockets.values()) {
      if (candidate.accountUser?.id === accountId) result.push(candidate);
    }
    return result;
  }

  function fail(code, message) {
    return { success: false, code, message };
  }

  function checkCreateRate(socket) {
    const nowMs = now();
    let bucket = createRateLimits.get(socket.id);
    if (!bucket || nowMs - bucket.startedAt > CREATE_RATE_WINDOW_MS) {
      bucket = { startedAt: nowMs, count: 0 };
      createRateLimits.set(socket.id, bucket);
    }
    bucket.count += 1;
    return bucket.count <= CREATE_RATE_LIMIT;
  }

  function cleanRate(socketId) {
    createRateLimits.delete(socketId);
  }

  // Serialize creation for one friend pair. Two simultaneous button presses
  // must resolve to one invitation and one room, never two.
  function withPairLock(key, task) {
    const previous = pairQueues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    pairQueues.set(key, tail);
    tail.then(() => {
      if (pairQueues.get(key) === tail) pairQueues.delete(key);
    });
    return run;
  }

  function uniqueRoomCode() {
    let code = generateRoomCode();
    let attempts = 0;
    while (rooms.has(code) && attempts < 1000) {
      code = generateRoomCode();
      attempts += 1;
    }
    return code;
  }

  function privateRoomCount() {
    let count = 0;
    for (const room of rooms.values()) if (room.private) count += 1;
    return count;
  }

  function clearInvitationTimer(invitation) {
    if (invitation?.timer) clearTimeout(invitation.timer);
    if (invitation) invitation.timer = null;
  }

  function removeInvitation(invitation) {
    if (!invitation) return;
    clearInvitationTimer(invitation);
    invitations.delete(invitation.id);
    if (invitationByPair.get(invitation.pairKey) === invitation.id) {
      invitationByPair.delete(invitation.pairKey);
    }
  }

  function notificationPayload(invitation) {
    return {
      invitationId: invitation.id,
      roomCode: invitation.roomCode,
      from: {
        id: invitation.fromAccountId,
        username: invitation.fromUsername,
        displayName: invitation.fromDisplayName,
        avatarUrl: invitation.fromAvatarUrl
      },
      expiresAt: new Date(invitation.expiresAt).toISOString(),
      message: `${invitation.fromDisplayName} wants to chat with you`
    };
  }

  function emitToAccount(accountId, event, payload) {
    for (const socket of accountSockets(accountId)) socket.emit(event, payload);
  }

  function emitInvitation(invitation) {
    emitToAccount(invitation.toAccountId, 'private-room:notification', notificationPayload(invitation));
  }

  function announceReady(room) {
    const present = new Set();
    for (const user of room.users.values()) {
      if (user.accountId) present.add(user.accountId);
    }
    const participants = room.participantAccountIds.map((accountId) => {
      const user = Array.from(room.users.values()).find((entry) => entry.accountId === accountId);
      return {
        accountId,
        username: user?.username || null,
        present: Boolean(user)
      };
    });
    io.to(room.code).emit('private-room:ready', {
      roomCode: room.code,
      invitationId: room.invitationId || null,
      ready: participants.every((participant) => participant.present),
      participants
    });
  }

  function expireInvitation(invitation) {
    if (!invitation || invitation.status === 'expired') return;
    if (invitation.status === 'accepted') return;
    invitation.status = 'expired';
    clearInvitationTimer(invitation);

    const payload = {
      invitationId: invitation.id,
      roomCode: invitation.roomCode,
      message: 'This chat invitation expired.'
    };
    emitToAccount(invitation.fromAccountId, 'private-room:expired', payload);
    emitToAccount(invitation.toAccountId, 'private-room:expired', payload);

    const room = rooms.get(invitation.roomCode);
    if (room && room.private) {
      // The invited account never joined, so the room has no useful lifetime.
      closeRoom(room, 'This chat invitation expired.');
    } else {
      removeInvitation(invitation);
    }
  }

  function scheduleExpiry(invitation) {
    clearInvitationTimer(invitation);
    const delay = Math.max(0, invitation.expiresAt - now());
    invitation.timer = setTimeout(() => expireInvitation(invitation), delay);
    invitation.timer.unref?.();
  }

  function activeInvitationForPair(key) {
    const invitationId = invitationByPair.get(key);
    if (!invitationId) return null;
    const invitation = invitations.get(invitationId);
    if (!invitation) {
      invitationByPair.delete(key);
      return null;
    }
    if (invitation.status === 'expired') {
      removeInvitation(invitation);
      return null;
    }
    if (invitation.status === 'pending' && invitation.expiresAt <= now()) {
      expireInvitation(invitation);
      return null;
    }
    return invitation;
  }

  // Add one authenticated account to a private room. A newer socket for the
  // same account replaces the older one so a reconnect never leaves a ghost
  // participant that could still acknowledge messages.
  function admitAccount(room, socket, user) {
    for (const [oldId, member] of Array.from(room.users.entries())) {
      if (member.accountId === user.id && oldId !== socket.id) {
        room.users.delete(oldId);
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket) {
          oldSocket.leave(room.code);
          if (oldSocket.roomId === room.code) oldSocket.roomId = null;
          oldSocket.emit('private-room:closed', {
            roomCode: room.code,
            invitationId: room.invitationId || null,
            reason: 'replaced',
            message: 'This private chat was opened on another device.'
          });
        }
      }
    }

    if (socket.roomId && socket.roomId !== room.code) leaveRoom(socket, true);

    // Invalidate any previous token for this account. Tokens are only useful
    // for the exact socket session that created them.
    for (const [token, member] of Array.from(room.members.entries())) {
      if (member.accountId === user.id) room.members.delete(token);
    }

    room.users.delete(socket.id);
    const token = newToken();
    const username = cleanName(user.username) || 'Guest';
    room.members.set(token, { username, accountId: user.id });
    room.users.set(socket.id, { id: socket.id, username, token, accountId: user.id });
    socket.join(room.code);
    socket.roomId = room.code;

    socket.to(room.code).emit('user-connected', { username, socketId: socket.id });
    broadcastUserList(room.code);
    announceReady(room);
    return token;
  }

  function createPrivateRoom(initiator, friend) {
    const code = uniqueRoomCode();
    const invitationId = newToken();
    const createdAt = now();
    const invitation = {
      id: invitationId,
      pairKey: pairKey(initiator.id, friend.id),
      roomCode: code,
      fromAccountId: initiator.id,
      toAccountId: friend.id,
      fromUsername: initiator.username,
      fromDisplayName: initiator.displayName || initiator.username,
      fromAvatarUrl: initiator.avatarUrl || null,
      toUsername: friend.username,
      toDisplayName: friend.displayName || friend.username,
      status: 'pending',
      createdAt,
      expiresAt: createdAt + invitationTtlMs,
      acceptedAt: null,
      timer: null
    };

    const room = {
      code,
      private: true,
      users: new Map(),
      game: null,
      hostId: null,
      hostToken: null,
      members: new Map(),
      pending: new Map(),
      emptyTimer: null,
      handoffTimer: null,
      participantAccountIds: [initiator.id, friend.id],
      invitationId,
      createdAt
    };

    rooms.set(code, room);
    invitations.set(invitationId, invitation);
    invitationByPair.set(invitation.pairKey, invitationId);
    scheduleExpiry(invitation);
    return { room, invitation };
  }

  function acceptInvitation(socket, invitationId, acknowledge) {
    const me = socket.accountUser;
    const invitation = invitations.get(String(invitationId || ''));
    if (!invitation) {
      acknowledge(fail('not_found', 'This invitation is no longer available.'));
      return;
    }
    if (invitation.toAccountId !== me.id) {
      acknowledge(fail('forbidden', 'This invitation is for another account.'));
      return;
    }
    if (invitation.status === 'expired' || invitation.expiresAt <= now()) {
      expireInvitation(invitation);
      acknowledge(fail('expired', 'This invitation has expired.'));
      return;
    }

    const room = rooms.get(invitation.roomCode);
    if (!room || !room.private) {
      removeInvitation(invitation);
      acknowledge(fail('expired', 'This private chat is no longer available.'));
      return;
    }
    if (!room.participantAccountIds.includes(me.id)) {
      acknowledge(fail('forbidden', 'You are not a participant in this chat.'));
      return;
    }

    const token = admitAccount(room, socket, me);
    invitation.status = 'accepted';
    invitation.acceptedAt = now();
    clearInvitationTimer(invitation);

    acknowledge({
      success: true,
      private: true,
      roomCode: room.code,
      token,
      username: cleanName(me.username) || 'Guest',
      isHost: false,
      invitationId: invitation.id
    });

    emitToAccount(invitation.fromAccountId, 'private-room:accepted', {
      invitationId: invitation.id,
      roomCode: room.code,
      user: { id: me.id, username: me.username, displayName: me.displayName || me.username }
    });
    for (const other of accountSockets(me.id)) {
      if (other.id !== socket.id) {
        other.emit('private-room:invitation-consumed', { invitationId: invitation.id });
      }
    }
  }

  io.on('connection', (socket) => {
    const me = socket.accountUser;

    // Re-deliver still-valid invitations after a reconnect or a fresh launch.
    if (me?.id) {
      for (const invitation of invitations.values()) {
        if (invitation.toAccountId !== me.id) continue;
        if (invitation.status !== 'pending') continue;
        if (invitation.expiresAt <= now()) {
          expireInvitation(invitation);
          continue;
        }
        socket.emit('private-room:notification', notificationPayload(invitation));
      }
    }

    socket.on('private-room:create', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') acknowledge = () => {};
      try {
        const user = socket.accountUser;
        if (!user?.id) return acknowledge(fail('unauthorized', 'Sign in to start a private chat.'));
        if (!store) return acknowledge(fail('unavailable', 'Private chat is temporarily unavailable.'));
        if (!checkCreateRate(socket)) return acknowledge(fail('rate_limited', 'Too many attempts. Please wait a moment.'));

        const friendId = typeof payload?.friendId === 'string' ? payload.friendId : '';
        if (!isValidId(friendId) || friendId === user.id) {
          return acknowledge(fail('invalid', 'Choose a friend to chat with.'));
        }

        const result = await withPairLock(pairKey(user.id, friendId), async () => {
          const friend = await store.findUserById(friendId);
          if (!friend) return fail('not_found', 'That account no longer exists.');
          if (!(await store.areFriends(user.id, friendId))) {
            return fail('not_friends', 'Private chat is only available with accepted friends.');
          }

          const key = pairKey(user.id, friendId);
          const existing = activeInvitationForPair(key);
          if (existing) {
            const existingRoom = rooms.get(existing.roomCode);
            if (existingRoom && existingRoom.private) {
              if (existing.status === 'pending' && existing.fromAccountId === user.id) {
                // A repeated click from the initiator reuses the same room.
                const token = admitAccount(existingRoom, socket, user);
                emitInvitation(existing);
                return {
                  success: true,
                  private: true,
                  roomCode: existingRoom.code,
                  token,
                  username: cleanName(user.username) || 'Guest',
                  isHost: false,
                  invitationId: existing.id,
                  reused: true
                };
              }
              if (existing.status === 'pending' && existing.toAccountId === user.id) {
                // Both friends pressed Chat at almost the same time. The
                // second request joins the invitation that won the lock.
                const token = admitAccount(existingRoom, socket, user);
                existing.status = 'accepted';
                existing.acceptedAt = now();
                clearInvitationTimer(existing);
                return {
                  success: true,
                  private: true,
                  roomCode: existingRoom.code,
                  token,
                  username: cleanName(user.username) || 'Guest',
                  isHost: false,
                  invitationId: existing.id,
                  reused: true,
                  accepted: true
                };
              }
              if (existing.status === 'accepted' && existingRoom.participantAccountIds.includes(user.id)) {
                // Reopening an accepted chat from the friend row.
                const token = admitAccount(existingRoom, socket, user);
                return {
                  success: true,
                  private: true,
                  roomCode: existingRoom.code,
                  token,
                  username: cleanName(user.username) || 'Guest',
                  isHost: false,
                  invitationId: existing.id,
                  reused: true
                };
              }
            }
            removeInvitation(existing);
          }

          if (privateRoomCount() >= MAX_PRIVATE_ROOMS) {
            return fail('unavailable', 'Too many private chats are active. Try again shortly.');
          }
          if (invitations.size >= MAX_INVITATIONS) {
            return fail('unavailable', 'Too many invitations are active. Try again shortly.');
          }

          const { room, invitation } = createPrivateRoom(user, friend);
          const token = admitAccount(room, socket, user);
          emitInvitation(invitation);
          return {
            success: true,
            private: true,
            roomCode: room.code,
            token,
            username: cleanName(user.username) || 'Guest',
            isHost: false,
            invitationId: invitation.id,
            created: true
          };
        });

        acknowledge(result);
      } catch (error) {
        console.error('[private-room] create failed:', error.code || error.name);
        acknowledge(fail('server_error', 'Unable to create a private chat right now.'));
      }
    });

    socket.on('private-room:accept', (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') acknowledge = () => {};
      try {
        const user = socket.accountUser;
        if (!user?.id) return acknowledge(fail('unauthorized', 'Sign in to join a private chat.'));
        acceptInvitation(socket, payload?.invitationId, acknowledge);
      } catch (error) {
        console.error('[private-room] accept failed:', error.code || error.name);
        acknowledge(fail('server_error', 'Unable to join this private chat right now.'));
      }
    });

    socket.on('private-room:join', (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') acknowledge = () => {};
      try {
        const user = socket.accountUser;
        if (!user?.id) return acknowledge(fail('unauthorized', 'Sign in to join a private chat.'));
        if (payload?.invitationId) return acceptInvitation(socket, payload.invitationId, acknowledge);

        const roomCode = String(payload?.roomCode || '').trim();
        const token = typeof payload?.token === 'string' ? payload.token : '';
        const room = rooms.get(roomCode);
        if (!room || !room.private) return acknowledge(fail('not_found', 'This private chat is no longer available.'));
        if (!room.participantAccountIds.includes(user.id)) {
          return acknowledge(fail('forbidden', 'You are not a participant in this chat.'));
        }
        const member = room.members.get(token);
        if (!member || member.accountId !== user.id) {
          return acknowledge(fail('unauthorized', 'This private chat session is no longer valid.'));
        }

        const freshToken = admitAccount(room, socket, user);
        acknowledge({
          success: true,
          private: true,
          roomCode: room.code,
          token: freshToken,
          username: cleanName(user.username) || 'Guest',
          isHost: false,
          invitationId: room.invitationId || null
        });
      } catch (error) {
        console.error('[private-room] join failed:', error.code || error.name);
        acknowledge(fail('server_error', 'Unable to join this private chat right now.'));
      }
    });

    socket.on('private-room:leave', (payload, acknowledge) => {
      try {
        leaveRoom(socket, true);
        socket.emit('left-room');
        if (typeof acknowledge === 'function') acknowledge({ success: true });
      } catch (_) {
        if (typeof acknowledge === 'function') acknowledge({ success: false });
      }
    });

    socket.on('disconnect', () => cleanRate(socket.id));
  });

  // Called by server.js when any room (public or private) is deleted.
  function onRoomClosed(room) {
    if (!room?.private) return;
    const invitation = invitations.get(room.invitationId);
    if (invitation) removeInvitation(invitation);
  }

  return { onRoomClosed, invitations };
}

module.exports = { installPrivateRooms, isPrivateRoom, DEFAULT_INVITATION_TTL_MS };
