'use strict';

// Integration tests for secure one-to-one temporary rooms.
//
// These tests exercise the real private-rooms module over a real Socket.IO
// server. Account authentication is replaced by a tiny in-memory profile map
// so the tests do not need PostgreSQL; every authorization decision in the
// module (friendship, invited account, participant account, token ownership)
// is still executed for real.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectSocket } = require('socket.io-client');
const { installPrivateRooms, isPrivateRoom, DEFAULT_INVITATION_TTL_MS } = require('../private-rooms');

const profiles = new Map([
  ['alice-account-id', { id: 'alice-account-id', username: 'alice', displayName: 'Alice' }],
  ['bob-account-id', { id: 'bob-account-id', username: 'bob', displayName: 'Bob' }],
  ['carol-account-id', { id: 'carol-account-id', username: 'carol', displayName: 'Carol' }],
  ['outsider-account-id', { id: 'outsider-account-id', username: 'outsider', displayName: 'Outsider' }]
]);

function pair(a, b) { return [a, b].sort().join(':'); }
const friendships = new Set([
  pair('alice-account-id', 'bob-account-id'),
  pair('bob-account-id', 'carol-account-id')
]);

const store = {
  pairKey: pair,
  areFriends: async (a, b) => friendships.has(pair(a, b)),
  findUserById: async (id) => profiles.get(id) || null
};

function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

function emitAck(socket, event, data, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement`)), timeout);
    socket.emit(event, data, (value) => { clearTimeout(timer); resolve(value); });
  });
}

function connect(url, userId) {
  return connectSocket(url, {
    auth: { testUserId: userId },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });
}

async function run() {
  const rooms = new Map();
  const server = http.createServer();
  const io = new Server(server, { transports: ['websocket'] });
  let fakeNow = Date.now();
  let service = null;
  const clients = [];

  io.use((socket, next) => {
    const profile = profiles.get(socket.handshake.auth?.testUserId);
    if (!profile) return next(new Error('not authenticated'));
    socket.accountUser = {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: null
    };
    next();
  });

  function newToken() { return crypto.randomBytes(12).toString('hex'); }
  function generateRoomCode() { return String(100000 + Math.floor(Math.random() * 900000)); }
  function cleanName(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 30); }

  function broadcastUserList(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit('update-users', Array.from(room.users.values()).map((user) => ({
      id: user.id,
      username: user.username,
      isHost: user.id === room.hostId,
      accountId: user.accountId || null
    })));
  }

  function closeRoom(room, message) {
    io.to(room.code).emit('private-room:closed', {
      roomCode: room.code,
      invitationId: room.invitationId || null,
      message
    });
    for (const socketId of room.users.keys()) {
      const member = io.sockets.sockets.get(socketId);
      if (!member) continue;
      member.leave(room.code);
      if (member.roomId === room.code) member.roomId = null;
    }
    rooms.delete(room.code);
    service?.onRoomClosed?.(room);
  }

  function leaveRoom(socket, explicit) {
    const room = rooms.get(socket.roomId);
    if (!room) { socket.roomId = null; return; }
    room.users.delete(socket.id);
    socket.leave(room.code);
    socket.roomId = null;
    if (room.private && explicit) closeRoom(room, 'The private chat ended.');
    else if (room.users.size === 0) closeRoom(room, 'This room is no longer available.');
    else {
      broadcastUserList(room.code);
      io.to(room.code).emit('private-room:ready', {
        roomCode: room.code,
        invitationId: room.invitationId || null,
        ready: false
      });
    }
  }

  // Minimal relay that mirrors the production chat contract: the recipient
  // must acknowledge before the sender sees delivery.
  io.on('connection', (socket) => {
    socket.on('chat-message', (payload, acknowledge) => {
      const room = rooms.get(socket.roomId);
      if (!room || !room.users.has(socket.id) || !payload?.to) {
        if (typeof acknowledge === 'function') acknowledge({ delivered: false });
        return;
      }
      const recipient = io.sockets.sockets.get(payload.to);
      if (!recipient || recipient.roomId !== socket.roomId || !room.users.has(recipient.id)) {
        if (typeof acknowledge === 'function') acknowledge({ delivered: false });
        return;
      }
      recipient.emit('chat-message', payload, (response) => {
        if (typeof acknowledge === 'function') acknowledge({ delivered: Boolean(response?.received) });
      });
    });
  });

  service = installPrivateRooms(io, {
    rooms,
    store,
    generateRoomCode,
    newToken,
    cleanName,
    broadcastUserList,
    closeRoom,
    leaveRoom,
    invitationTtlMs: DEFAULT_INVITATION_TTL_MS,
    now: () => fakeNow
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    // --- 1/2: Alice creates a private room and is admitted -----------------
    const alice = connect(url, 'alice-account-id'); clients.push(alice);
    await waitFor(alice, 'connect');
    const created = await emitAck(alice, 'private-room:create', { friendId: 'bob-account-id' });
    assert.equal(created.success, true, created.message);
    assert.equal(created.private, true);
    assert.match(created.roomCode, /^\d{6}$/);
    assert.ok(created.token);
    assert.ok(created.invitationId);
    const roomCode = created.roomCode;
    const invitationId = created.invitationId;
    assert.equal(rooms.get(roomCode).users.size, 1);
    assert.equal(isPrivateRoom(rooms.get(roomCode)), true);
    console.log('PASS 1-2: Alice created and joined a private room');

    // --- 3: Bob receives the invitation while on Friends -------------------
    const bob = connect(url, 'bob-account-id'); clients.push(bob);
    const bobInvitation = await waitFor(bob, 'private-room:notification');
    assert.equal(bobInvitation.invitationId, invitationId);
    assert.equal(bobInvitation.roomCode, roomCode);
    assert.equal(bobInvitation.from.id, 'alice-account-id');
    assert.equal(bobInvitation.from.username, 'alice');
    assert.match(bobInvitation.message, /Alice wants to chat with you/);
    console.log('PASS 3: Bob received a real-time invitation');

    // --- 4/5: Bob accepts and joins the exact same room --------------------
    const accepted = await emitAck(bob, 'private-room:accept', { invitationId });
    assert.equal(accepted.success, true, accepted.message);
    assert.equal(accepted.private, true);
    assert.equal(accepted.roomCode, roomCode);
    assert.ok(accepted.token);
    const bobToken = accepted.token;
    const adapterRoom = io.sockets.adapter.rooms.get(roomCode);
    assert.ok(adapterRoom?.has(alice.id), 'Alice must be in the Socket.IO room');
    assert.ok(adapterRoom?.has(bob.id), 'Bob must be in the Socket.IO room');
    assert.equal(rooms.get(roomCode).users.size, 2);
    console.log('PASS 4-5: Bob accepted and joined the original room');

    // --- 6: Both users exchange messages ----------------------------------
    const aliceInbox = waitFor(alice, 'chat-message');
    const bobInbox = waitFor(bob, 'chat-message');
    bob.once('chat-message', (_payload, acknowledge) => acknowledge({ received: true }));
    alice.once('chat-message', (_payload, acknowledge) => acknowledge({ received: true }));
    const aliceSend = await emitAck(alice, 'chat-message', { id: 'm1', to: bob.id, text: 'hello bob' });
    assert.equal(aliceSend.delivered, true);
    const bobReceived = await bobInbox;
    assert.equal(bobReceived.text, 'hello bob');
    const bobSend = await emitAck(bob, 'chat-message', { id: 'm2', to: alice.id, text: 'hello alice' });
    assert.equal(bobSend.delivered, true);
    const aliceReceived = await aliceInbox;
    assert.equal(aliceReceived.text, 'hello alice');
    console.log('PASS 6: Both participants exchanged acknowledged messages');

    // --- 7: A third account cannot join ----------------------------------
    const outsider = connect(url, 'outsider-account-id'); clients.push(outsider);
    await waitFor(outsider, 'connect');
    const outsiderJoin = await emitAck(outsider, 'private-room:join', { roomCode, token: bobToken });
    assert.equal(outsiderJoin.success, false);
    assert.equal(outsiderJoin.code, 'forbidden');
    const outsiderAccept = await emitAck(outsider, 'private-room:accept', { invitationId });
    assert.equal(outsiderAccept.success, false);
    assert.equal(outsiderAccept.code, 'forbidden');
    console.log('PASS 7: A third account cannot join or accept');

    // --- 8: A non-friend cannot create an invitation ---------------------
    const nonFriend = await emitAck(alice, 'private-room:create', { friendId: 'carol-account-id' });
    assert.equal(nonFriend.success, false);
    assert.equal(nonFriend.code, 'not_friends');
    console.log('PASS 8: A non-friend cannot create an invitation');

    // --- 9: Repeated clicks reuse the same room --------------------------
    const repeated = await emitAck(alice, 'private-room:create', { friendId: 'bob-account-id' });
    assert.equal(repeated.success, true, repeated.message);
    assert.equal(repeated.roomCode, roomCode);
    assert.equal(repeated.invitationId, invitationId);
    assert.equal(repeated.reused, true);
    assert.equal(rooms.size, 1);
    console.log('PASS 9: Repeated clicks did not create a duplicate room');

    // --- 10: Bob reconnects and restores the same room -------------------
    bob.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const bobAgain = connect(url, 'bob-account-id'); clients.push(bobAgain);
    await waitFor(bobAgain, 'connect');
    const rejoined = await emitAck(bobAgain, 'private-room:join', { roomCode, token: bobToken });
    assert.equal(rejoined.success, true, rejoined.message);
    assert.equal(rejoined.roomCode, roomCode);
    const restoredRoom = io.sockets.adapter.rooms.get(roomCode);
    assert.ok(restoredRoom?.has(alice.id));
    assert.ok(restoredRoom?.has(bobAgain.id));
    console.log('PASS 10: Bob reconnected and restored the same room');

    // --- 12: Unauthorized accounts cannot accept an invitation ----------
    const carol = connect(url, 'carol-account-id'); clients.push(carol);
    await waitFor(carol, 'connect');
    const carolToBob = await emitAck(carol, 'private-room:create', { friendId: 'bob-account-id' });
    assert.equal(carolToBob.success, true, carolToBob.message);
    assert.notEqual(carolToBob.roomCode, roomCode);
    const aliceAccept = await emitAck(alice, 'private-room:accept', { invitationId: carolToBob.invitationId });
    assert.equal(aliceAccept.success, false);
    assert.equal(aliceAccept.code, 'forbidden');
    const outsiderAcceptCarol = await emitAck(outsider, 'private-room:accept', { invitationId: carolToBob.invitationId });
    assert.equal(outsiderAcceptCarol.success, false);
    assert.equal(outsiderAcceptCarol.code, 'forbidden');
    console.log('PASS 12: Unauthorized accounts cannot accept an invitation');

    // --- 11: Expired invitations are rejected ---------------------------
    fakeNow += DEFAULT_INVITATION_TTL_MS + 1000;
    const expiredAccept = await emitAck(bobAgain, 'private-room:accept', { invitationId: carolToBob.invitationId });
    assert.equal(expiredAccept.success, false);
    assert.equal(expiredAccept.code, 'expired');
    assert.equal(rooms.has(carolToBob.roomCode), false, 'Expired room must be closed');
    console.log('PASS 11: Expired invitations are rejected and cleaned up');

    // --- 13: Both users leave and cleanup works -------------------------
    const closedForBob = waitFor(bobAgain, 'private-room:closed');
    await emitAck(alice, 'private-room:leave', {});
    const closedPayload = await closedForBob;
    assert.equal(closedPayload.roomCode, roomCode);
    assert.equal(rooms.has(roomCode), false);
    assert.equal(service.invitations.size, 0);
    console.log('PASS 13: Leaving closed the room and removed the invitation');

    // --- Public-room regression: the public code path still works -------
    const publicRoom = {
      code: '123456',
      private: false,
      users: new Map(),
      hostId: null,
      hostToken: 'host-token',
      members: new Map(),
      pending: new Map()
    };
    rooms.set(publicRoom.code, publicRoom);
    assert.equal(isPrivateRoom(publicRoom), false);
    assert.equal(rooms.get('123456').private, false);
    console.log('PASS 14: Public rooms are still classified as public');

    console.log('PRIVATE ROOM TESTS PASSED');
  } finally {
    for (const client of clients) {
      try { client.disconnect(); } catch (_) { /* already gone */ }
    }
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error('PRIVATE ROOM TESTS FAILED:', error);
  process.exitCode = 1;
});
