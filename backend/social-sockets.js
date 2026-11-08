'use strict';

const crypto = require('node:crypto');

const PRIVATE_MAX_CONVERSATIONS = 250;
const PRIVATE_MAX_MESSAGES_PER_CONVERSATION = 100;
const PRIVATE_MAX_TEXT_LENGTH = 4000;
const PRIVATE_MAX_BUFFERED_CHARS = 8 * 1024 * 1024;
const PRIVATE_SEND_RATE_LIMIT = 30;
const PRIVATE_SEND_RATE_WINDOW_MS = 10000;
const PRIVATE_TTL_MS = 10 * 60 * 1000;
const PRIVATE_EDIT_WINDOW_MS = 15 * 60 * 1000;
const PRIVATE_MAX_REPLY_EXCERPT = 180;
const PRIVATE_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏']);

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,96}$/;

// Deterministic, opaque conversation id for a friend pair. The id is stable
// for the lifetime of the process but is never written to the database.
function conversationIdFor(pairKey) {
  return 'dm_' + crypto.createHash('sha256').update(pairKey).digest('hex').slice(0, 32);
}

function installSocialSockets(io, store, accountService, options = {}) {
  const activeSocketsByUser = new Map();
  const conversations = new Map();       // convId -> { id, pairKey, userIds, messages, seenIds, sockets }
  const conversationByPair = new Map();  // pairKey -> convId (active sessions only)
  const privateRateLimits = new Map();
  const now = options.now || Date.now;
  let totalBufferedChars = 0;

  const accountSockets = (userId) => activeSocketsByUser.get(userId) || new Set();
  const isOnline = (userId) => accountSockets(userId).size > 0;
  // Every authenticated device currently connected for an account. A friend
  // does not have to have opened the chat before a message can reach them:
  // the recipient device acknowledges the event and either renders it in the
  // active conversation or keeps it in its own short-lived inbox.
  const userSockets = (userId) => [...accountSockets(userId)]
    .map((socketId) => io.sockets.sockets.get(socketId))
    .filter(Boolean);

  // Deliver a conversation event to every authenticated device of both
  // participants. Clients ignore events for conversations they do not have
  // open, so this keeps a second device in sync without storing anything.
  function emitToConversationUsers(conversation, event, payload) {
    for (const userId of new Set(conversation.userIds)) {
      io.to('account:' + userId).emit(event, payload);
    }
  }

  function memberConversation(socket, conversationId) {
    if (typeof conversationId !== 'string' || !socket.privateConversationIds?.has(conversationId)) return null;
    const conversation = conversations.get(conversationId);
    if (!conversation || !conversation.sockets.has(socket.id)) return null;
    if (!conversation.userIds.includes(socket.accountUser.id)) return null;
    return conversation;
  }

  // A block applies in both directions and must keep applying to a
  // conversation that was already open when the block happened. Conversation
  // membership alone is not enough authorization for message mutations.
  async function conversationBlocked(conversation) {
    if (typeof store.isBlocked !== 'function') return false;
    const [firstId, secondId] = conversation.userIds || [];
    if (!firstId || !secondId) return false;
    try {
      return await store.isBlocked(firstId, secondId);
    } catch (_) {
      return false;
    }
  }

  function presencePayload(userId, online, lastSeenAt) {
    return {
      userId,
      online,
      observedAt: new Date(now()).toISOString(),
      lastSeenAt: lastSeenAt || null
    };
  }

  // Honor each account's online-status visibility setting. `friends` is the
  // default and matches the existing behaviour; `nobody` hides presence
  // entirely; `everyone` is explicit.
  async function presenceVisibleTo(targetId, viewerId) {
    if (typeof store.getPrivacySettings !== 'function') return true;
    try {
      const settings = await store.getPrivacySettings(targetId);
      if (settings.onlineStatusVisibility === 'nobody') return false;
      if (settings.onlineStatusVisibility === 'friends') {
        return typeof store.areFriends === 'function' ? store.areFriends(targetId, viewerId) : true;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  // Notify the *friends of* userId about userId's state. This is the important
  // direction: a user's own sockets must not receive their own presence.
  async function publishPresenceToFriends(userId, online, lastSeenAt = null) {
    if (typeof store.getPrivacySettings === 'function') {
      try {
        const settings = await store.getPrivacySettings(userId);
        if (settings.onlineStatusVisibility === 'nobody') return;
      } catch (_) { /* Fall back to notifying friends. */ }
    }
    const friends = await store.listFriends(userId);
    for (const friend of friends) {
      io.to('account:' + friend._id).emit('friends:presence', presencePayload(userId, online, lastSeenAt));
    }
  }

  function destroyConversation(conversationId) {
    const conversation = conversations.get(conversationId);
    if (conversation) {
      for (const message of conversation.messages) totalBufferedChars -= message.text.length;
      for (const [pairKey, id] of conversationByPair) {
        if (id === conversationId) conversationByPair.delete(pairKey);
      }
      conversations.delete(conversationId);
    }
  }

  function leaveConversation(socket, conversationId) {
    socket.privateConversationIds?.delete(conversationId);
    socket.leave(`private:${conversationId}`);
    const conversation = conversations.get(conversationId);
    if (conversation) {
      conversation.sockets.delete(socket.id);
      // Privacy: clear the conversation as soon as the last participant leaves.
      if (conversation.sockets.size === 0) destroyConversation(conversationId);
    }
  }

  function leaveAll(socket) {
    for (const id of [...(socket.privateConversationIds || [])]) leaveConversation(socket, id);
  }

  io.on('connection', (socket) => {
    const user = socket.accountUser;
    if (!user) return;
    let sockets = activeSocketsByUser.get(user.id);
    const wasOnline = Boolean(sockets?.size);
    if (!sockets) activeSocketsByUser.set(user.id, sockets = new Set());
    sockets.add(socket.id);
    socket.join(`account:${user.id}`);
    if (socket.accountAuthExpiresAt) {
      const wait = Math.max(0, socket.accountAuthExpiresAt - now());
      const timer = setTimeout(() => socket.disconnect(true), wait);
      timer.unref?.();
      socket.once('disconnect', () => clearTimeout(timer));
    }

    store.listFriends(user.id).then((friends) => {
      socket.emit('social:ready', {
        user: { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, lastSeenAt: user.lastSeenAt || null },
        friends: friends.map((friend) => {
          const canSee = (friend.onlineStatusVisibility || 'friends') !== 'nobody';
          return {
            id: friend._id,
            username: friend.username,
            displayName: friend.displayName,
            avatarUrl: friend.avatarUrl || null,
            online: canSee && isOnline(friend._id),
            lastSeenAt: canSee ? friend.lastSeenAt || null : null
          };
        })
      });
    }).catch((error) => {
      console.error('[social] presence initialization failed:', error.code || error.name);
    }).finally(() => {
      // Re-check online state: the socket may have disconnected while the
      // friend list was loading, in which case the offline event must win.
      if (!wasOnline && isOnline(user.id)) {
        publishPresenceToFriends(user.id, true)
          .catch((error) => console.error('[social] presence publish failed:', error.code || error.name));
      }
    });

    socket.on('private:open', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        if (!socket.accountUser || typeof payload?.friendId !== 'string' || payload.friendId === socket.accountUser.id) {
          throw new Error('A valid friend is required.');
        }
        if (!(await store.areFriends(socket.accountUser.id, payload.friendId))) {
          throw new Error('Private chats are available only between accepted friends.');
        }
        if (typeof store.isBlocked === 'function' && await store.isBlocked(socket.accountUser.id, payload.friendId)) {
          throw new Error('This conversation is unavailable.');
        }

        const pairKey = store.pairKey(socket.accountUser.id, payload.friendId);
        const conversationId = conversationIdFor(pairKey);

        // A socket participates in one private conversation at a time. Leaving
        // any previous conversation here prevents a stale room membership from
        // acknowledging messages the user can no longer see after switching
        // chats.
        leaveAll(socket);

        let conversation = conversations.get(conversationId);
        if (!conversation) {
          if (conversations.size >= PRIVATE_MAX_CONVERSATIONS) {
            throw new Error('The private chat service is at capacity. Try again shortly.');
          }
          conversation = {
            id: conversationId,
            pairKey,
            userIds: [socket.accountUser.id, payload.friendId],
            messages: [],
            seenIds: new Set(),
            sockets: new Set()
          };
          conversations.set(conversationId, conversation);
        }

        conversationByPair.set(pairKey, conversationId);
        socket.privateConversationIds ||= new Set();
        socket.privateConversationIds.add(conversationId);
        socket.join(`private:${conversationId}`);
        conversation.sockets.add(socket.id);

        // No history: a reopened conversation always starts empty.
        acknowledge({
          success: true,
          conversation: {
            id: conversationId,
            peerId: payload.friendId,
            peerOnline: await presenceVisibleTo(payload.friendId, socket.accountUser.id) ? isOnline(payload.friendId) : false,
            messages: []
          }
        });
      } catch (error) {
        acknowledge({ success: false, message: error.message });
      }
    });

    socket.on('private:leave', (payload) => {
      if (typeof payload?.conversationId === 'string') leaveConversation(socket, payload.conversationId);
    });

    socket.on('private:typing', (payload) => {
      if (typeof payload?.conversationId !== 'string' || typeof payload?.isTyping !== 'boolean') return;
      const conversation = conversations.get(payload.conversationId);
      if (!conversation || !conversation.sockets.has(socket.id)) return;
      socket.to(`private:${payload.conversationId}`).emit('private:typing', {
        conversationId: payload.conversationId,
        userId: user.id,
        isTyping: payload.isTyping
      });
    });

    socket.on('private:list', async (_payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        const entries = await Promise.all([...conversations.values()]
          .filter((conversation) => conversation.userIds.includes(user.id))
          .map(async (conversation) => {
            const friendId = conversation.userIds.find((id) => id !== user.id);
            // Honor the friend's online-status visibility setting even for a
            // conversation that is already open.
            const canSeePresence = await presenceVisibleTo(friendId, user.id);
            return { id: conversation.id, friendId, online: canSeePresence && isOnline(friendId) };
          }));
        // Deliberately no lastMessage/history in this response.
        acknowledge({ success: true, conversations: entries });
      } catch (_) {
        acknowledge({ success: false, conversations: [] });
      }
    });

    socket.on('private:send', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const senderId = user.id;

      try {
        if (typeof payload?.conversationId !== 'string' || !socket.privateConversationIds?.has(payload.conversationId)) {
          acknowledge({ success: false, delivered: false, reason: 'unauthorized' });
          return;
        }
        const conversation = conversations.get(payload.conversationId);
        if (!conversation || !conversation.sockets.has(socket.id)) {
          acknowledge({ success: false, delivered: false, reason: 'unauthorized' });
          return;
        }
        if (typeof payload?.id !== 'string' || !MESSAGE_ID_RE.test(payload.id) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > PRIVATE_MAX_TEXT_LENGTH) {
          acknowledge({ success: false, delivered: false, reason: 'invalid_message' });
          return;
        }
        if (payload.forwarded != null && typeof payload.forwarded !== 'boolean') {
          acknowledge({ success: false, delivered: false, reason: 'invalid_message' });
          return;
        }
        if (payload.replyTo != null) {
          const reply = payload.replyTo;
          if (typeof reply !== 'object'
            || typeof reply.id !== 'string'
            || !MESSAGE_ID_RE.test(reply.id)
            || (reply.sender != null && (typeof reply.sender !== 'string' || reply.sender.length > 64))
            || (reply.excerpt != null && (typeof reply.excerpt !== 'string' || reply.excerpt.length > PRIVATE_MAX_REPLY_EXCERPT))) {
            acknowledge({ success: false, delivered: false, reason: 'invalid_message' });
            return;
          }
        }

        const rate = privateRateLimits.get(senderId);
        const timestamp = now();
        if (!rate || timestamp - rate.startedAt >= PRIVATE_SEND_RATE_WINDOW_MS) privateRateLimits.set(senderId, { startedAt: timestamp, count: 1 });
        else if (++rate.count > PRIVATE_SEND_RATE_LIMIT) { acknowledge({ success: false, delivered: false, reason: 'rate_limited' }); return; }

        const peerId = conversation.userIds.find((id) => id !== senderId);
        if (!conversation.userIds.includes(senderId) || !peerId) {
          acknowledge({ success: false, delivered: false, reason: 'unauthorized' });
          return;
        }
        if (!(await store.areFriends(senderId, peerId))) {
          leaveConversation(socket, payload.conversationId);
          acknowledge({ success: false, delivered: false, reason: 'friendship_required' });
          return;
        }
        if (typeof store.isBlocked === 'function' && await store.isBlocked(senderId, peerId)) {
          leaveConversation(socket, payload.conversationId);
          acknowledge({ success: false, delivered: false, reason: 'blocked' });
          return;
        }

        if (conversation.seenIds.has(payload.id)) {
          acknowledge({ success: true, delivered: true, duplicate: true, id: payload.id });
          return;
        }

        // Deliver to every authenticated device the recipient currently has
        // connected. This is the fix for an online friend who has not opened
        // the chat yet: opening a chat is not a precondition for receiving a
        // message in the ephemeral model, but an acknowledgement still is.
        // The recipient client acknowledges only after rendering the message
        // or placing it in its own in-memory inbox.
        const recipients = userSockets(peerId).filter((recipient) => recipient.id !== socket.id);
        if (!recipients.length) {
          // Do not retain text that had no possible recipient. A different
          // device owned by the sender must never count as peer delivery.
          const reason = isOnline(peerId) ? 'recipient_unavailable' : 'recipient_offline';
          acknowledge({ success: true, delivered: false, reason, id: payload.id });
          return;
        }

        const message = {
          id: payload.id,
          conversationId: payload.conversationId,
          from: senderId,
          sender: user.displayName || user.username,
          text: payload.text.trim(),
          timestamp,
          replyTo: payload.replyTo ? {
            id: payload.replyTo.id,
            sender: payload.replyTo.sender ? String(payload.replyTo.sender).slice(0, 64) : null,
            excerpt: payload.replyTo.excerpt ? String(payload.replyTo.excerpt).slice(0, PRIVATE_MAX_REPLY_EXCERPT) : null
          } : null,
          forwarded: Boolean(payload.forwarded),
          editedAt: null,
          deletedAt: null,
          reactions: {},
          seenBy: []
        };

        if (totalBufferedChars + message.text.length > PRIVATE_MAX_BUFFERED_CHARS) {
          acknowledge({ success: false, delivered: false, reason: 'memory_capacity' });
          return;
        }

        // Ephemeral only: the message lives in this process memory while the
        // conversation is active. It is never written to PostgreSQL or logs.
        conversation.seenIds.add(message.id);
        conversation.messages.push(message);
        totalBufferedChars += message.text.length;
        while (conversation.messages.length > PRIVATE_MAX_MESSAGES_PER_CONVERSATION) {
          const removed = conversation.messages.shift();
          conversation.seenIds.delete(removed.id);
          totalBufferedChars -= removed.text.length;
        }

        let remaining = recipients.length;
        let delivered = false;
        let settled = false;
        const finish = () => {
          if (settled || --remaining > 0) return;
          settled = true;
          if (!delivered) {
            // Nobody acknowledged the message. Remove it from the ephemeral
            // buffer so a retry is not blocked by a message that was never
            // received, and so the sender's failure status stays truthful.
            conversation.seenIds.delete(message.id);
            const index = conversation.messages.indexOf(message);
            if (index !== -1) {
              conversation.messages.splice(index, 1);
              totalBufferedChars -= message.text.length;
            }
          }
          acknowledge({ success: true, delivered, id: payload.id, reason: delivered ? undefined : 'recipient_unavailable' });
        };
        for (const recipient of recipients) {
          io.to(recipient.id).timeout(5000).emit('private:message', message, (error, responses) => {
            if (!error && Array.isArray(responses) && responses.some((response) => response?.received === true)) delivered = true;
            finish();
          });
        }
      } catch (_) {
        acknowledge({ success: false, delivered: false, reason: 'server_error' });
      }
    });

    // -----------------------------------------------------------------------
    // Ephemeral message operations
    // Every operation is authorized against the in-memory conversation, so the
    // server never trusts a client-provided author. Content stays RAM-only.
    // -----------------------------------------------------------------------

    socket.on('private:seen', async (payload, acknowledge) => {
      const done = typeof acknowledge === 'function' ? acknowledge : () => {};
      const conversation = memberConversation(socket, payload?.conversationId);
      if (!conversation) return done({ success: false, reason: 'unauthorized' });
      if (await conversationBlocked(conversation)) return done({ success: false, reason: 'blocked' });
      const ids = Array.isArray(payload?.messageIds) ? [...new Set(payload.messageIds)] : [];
      if (!ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !MESSAGE_ID_RE.test(id))) {
        return done({ success: false, reason: 'invalid_message' });
      }
      const peerId = conversation.userIds.find((id) => id !== user.id);
      const seen = [];
      for (const id of ids) {
        const message = conversation.messages.find((entry) => entry.id === id);
        if (!message || message.from !== peerId || message.deletedAt) continue;
        if (!message.seenBy.includes(user.id)) message.seenBy.push(user.id);
        seen.push(id);
      }
      if (seen.length) {
        emitToConversationUsers(conversation, 'private:seen', {
          conversationId: conversation.id,
          messageIds: seen,
          by: user.id
        });
      }
      done({ success: true, seen });
    });

    socket.on('private:edit', async (payload, acknowledge) => {
      const done = typeof acknowledge === 'function' ? acknowledge : () => {};
      const conversation = memberConversation(socket, payload?.conversationId);
      if (!conversation) return done({ success: false, reason: 'unauthorized' });
      if (await conversationBlocked(conversation)) return done({ success: false, reason: 'blocked' });
      const message = conversation.messages.find((entry) => entry.id === payload?.id);
      if (!message) return done({ success: false, reason: 'not_found' });
      if (message.from !== user.id) return done({ success: false, reason: 'forbidden' });
      if (message.deletedAt) return done({ success: false, reason: 'deleted' });
      if (now() - message.timestamp > PRIVATE_EDIT_WINDOW_MS) return done({ success: false, reason: 'edit_window' });
      if (typeof payload?.text !== 'string' || !payload.text.trim() || payload.text.length > PRIVATE_MAX_TEXT_LENGTH) {
        return done({ success: false, reason: 'invalid_message' });
      }
      const nextText = payload.text.trim();
      const nextBufferedChars = totalBufferedChars + nextText.length - message.text.length;
      if (nextBufferedChars > PRIVATE_MAX_BUFFERED_CHARS) {
        return done({ success: false, reason: 'buffer_full' });
      }
      totalBufferedChars = nextBufferedChars;
      message.text = nextText;
      message.editedAt = now();
      emitToConversationUsers(conversation, 'private:edited', {
        conversationId: conversation.id,
        id: message.id,
        text: nextText,
        editedAt: message.editedAt
      });
      done({ success: true, id: message.id, text: nextText, editedAt: message.editedAt });
    });

    socket.on('private:delete', async (payload, acknowledge) => {
      const done = typeof acknowledge === 'function' ? acknowledge : () => {};
      const conversation = memberConversation(socket, payload?.conversationId);
      if (!conversation) return done({ success: false, reason: 'unauthorized' });
      if (await conversationBlocked(conversation)) return done({ success: false, reason: 'blocked' });
      const message = conversation.messages.find((entry) => entry.id === payload?.id);
      if (!message) return done({ success: false, reason: 'not_found' });
      if (message.from !== user.id) return done({ success: false, reason: 'forbidden' });
      if (!message.deletedAt) {
        message.deletedAt = now();
        totalBufferedChars -= message.text.length;
        message.text = '';
        message.reactions = {};
      }
      emitToConversationUsers(conversation, 'private:deleted', {
        conversationId: conversation.id,
        id: message.id
      });
      done({ success: true, id: message.id });
    });

    socket.on('private:react', async (payload, acknowledge) => {
      const done = typeof acknowledge === 'function' ? acknowledge : () => {};
      const conversation = memberConversation(socket, payload?.conversationId);
      if (!conversation) return done({ success: false, reason: 'unauthorized' });
      if (await conversationBlocked(conversation)) return done({ success: false, reason: 'blocked' });
      const message = conversation.messages.find((entry) => entry.id === payload?.id);
      if (!message) return done({ success: false, reason: 'not_found' });
      if (message.deletedAt) return done({ success: false, reason: 'deleted' });
      const emoji = typeof payload?.emoji === 'string' ? payload.emoji : '';
      if (!PRIVATE_REACTION_EMOJIS.has(emoji)) return done({ success: false, reason: 'invalid_reaction' });

      const users = Array.isArray(message.reactions[emoji]) ? message.reactions[emoji] : [];
      const index = users.indexOf(user.id);
      if (index === -1) users.push(user.id);
      else users.splice(index, 1);
      if (users.length) message.reactions[emoji] = users;
      else delete message.reactions[emoji];

      emitToConversationUsers(conversation, 'private:reaction', {
        conversationId: conversation.id,
        id: message.id,
        emoji,
        reactions: message.reactions,
        by: user.id
      });
      done({ success: true, id: message.id, reactions: message.reactions });
    });

    socket.on('disconnect', () => {
      leaveAll(socket);
      const current = activeSocketsByUser.get(user.id);
      if (!current) return;
      current.delete(socket.id);
      if (current.size === 0) {
        activeSocketsByUser.delete(user.id);
        privateRateLimits.delete(user.id);
        const lastSeenAt = new Date(now()).toISOString();
        const update = typeof store.setLastSeen === 'function' ? store.setLastSeen(user.id, new Date(now())) : Promise.resolve();
        Promise.resolve(update)
          .catch(() => {})
          .then(() => publishPresenceToFriends(user.id, false, lastSeenAt))
          .catch((error) => console.error('[social] presence update failed:', error.code || error.name));
      }
    });
  });

  return {
    activeSocketsByUser,
    conversations,
    dispose: () => {
      conversationByPair.clear();
      conversations.clear();
      activeSocketsByUser.clear();
      privateRateLimits.clear();
      totalBufferedChars = 0;
    }
  };
}

module.exports = {
  installSocialSockets,
  PRIVATE_MAX_CONVERSATIONS,
  PRIVATE_MAX_MESSAGES_PER_CONVERSATION,
  PRIVATE_MAX_TEXT_LENGTH,
  PRIVATE_TTL_MS
};
