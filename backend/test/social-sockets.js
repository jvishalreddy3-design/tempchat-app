'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectSocket } = require('socket.io-client');
const { installSocialSockets } = require('../social-sockets');

const profiles = new Map([
  ['alice-id', { _id: 'alice-id', username: 'alice', displayName: 'Alice' }],
  ['bob-id', { _id: 'bob-id', username: 'bob', displayName: 'Bob' }],
  ['outsider-id', { _id: 'outsider-id', username: 'outsider', displayName: 'Outsider' }]
]);
const friendship = ['alice-id', 'bob-id'].sort().join(':');
const store = {
  pairKey: (a, b) => [a, b].sort().join(':'),
  areFriends: async (a, b) => [a, b].sort().join(':') === friendship,
  findUserById: async (id) => profiles.get(id) || null,
  listFriends: async (id) => id === 'alice-id' ? [profiles.get('bob-id')] : id === 'bob-id' ? [profiles.get('alice-id')] : [],
  getPrivateConversation: async () => null,
  createPrivateConversation: async (userIds, pairKey) => ({ _id: 'conv-test', id: 'conv-test', pair_key: pairKey, userIds: userIds.sort() }),
  getPrivateConversationById: async () => ({ _id: 'conv-test', id: 'conv-test', pair_key: friendship, userIds: ['alice-id', 'bob-id'] }),
  findPrivateMessageById: async (id) => store._messages?.find((m) => m.id === id) || null,
  savePrivateMessage: async (convId, message) => { store._messages = store._messages || []; store._messages.push(message); return { _id: message.id, id: message.id, conversationId: convId, from: message.from, sender: message.sender, text: message.text, timestamp: message.timestamp, deliveredTo: [], createdAt: new Date() }; },
  getPrivateMessages: async () => [],
  markConversationMessagesDelivered: async () => {}
};

function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}
function connect(url, id) { return connectSocket(url, { auth: { testUserId: id }, transports: ['websocket'], forceNew: true, reconnection: false }); }
function emitAck(socket, event, data) { return new Promise((resolve) => socket.emit(event, data, resolve)); }

async function run() {
  const server = http.createServer();
  const io = new Server(server, { transports: ['websocket'] });
  io.use((socket, next) => {
    const profile = profiles.get(socket.handshake.auth?.testUserId);
    if (!profile) return next(new Error('not authenticated'));
    socket.accountUser = { id: profile._id, username: profile.username, displayName: profile.displayName };
    socket.accountAuthExpiresAt = Date.now() + 60000;
    next();
  });
  const social = installSocialSockets(io, store, {}, { privateTtlMs: 40 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  try {
    const alice = connect(url, 'alice-id'); clients.push(alice);
    const aliceReady = waitFor(alice, 'social:ready');
    await waitFor(alice, 'connect'); await aliceReady;
    const bobFirst = connect(url, 'bob-id'); clients.push(bobFirst);
    const alicePresence = [];
    alice.on('friends:presence', (value) => alicePresence.push(value));
    const firstBobReady = waitFor(bobFirst, 'social:ready');
    const bobOnline = waitFor(alice, 'friends:presence');
    await waitFor(bobFirst, 'connect'); await firstBobReady; await bobOnline;
    const bobSecond = connect(url, 'bob-id'); clients.push(bobSecond);
    const secondBobReady = waitFor(bobSecond, 'social:ready');
    await waitFor(bobSecond, 'connect'); await secondBobReady;
    bobFirst.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(alicePresence.some((value) => value.online === false), false, 'one device disconnect must not mark a multi-device friend offline');
    bobSecond.disconnect();
    const lastDeviceOffline = waitFor(alice, 'friends:presence');
    await lastDeviceOffline;
    assert.equal(alicePresence.at(-1).online, false, 'last device disconnect must mark a friend offline');

    const bob = connect(url, 'bob-id'); clients.push(bob);
    const bobReady = waitFor(bob, 'social:ready');
    await waitFor(bob, 'connect'); await bobReady;
    let received = 0;
    bob.on('private:message', (message, acknowledge) => { received++; acknowledge({ received: true }); });
    const aliceOpen = await emitAck(alice, 'private:open', { friendId: 'bob-id' });
    assert.equal(aliceOpen.success, true);
    assert.equal(aliceOpen.conversation.peerOnline, true);
    const bobOpen = await emitAck(bob, 'private:open', { friendId: 'alice-id' });
    assert.equal(bobOpen.success, true);
    assert.equal(bobOpen.conversation.id, aliceOpen.conversation.id);

    const message = { conversationId: aliceOpen.conversation.id, id: 'message-test-0001', text: 'temporary, in-memory only' };
    const delivered = await emitAck(alice, 'private:send', message);
    assert.equal(delivered.delivered, true);
    assert.equal(received, 1);
    const duplicate = await emitAck(alice, 'private:send', message);
    assert.equal(duplicate.duplicate, true);
    assert.equal(received, 1, 'duplicate IDs must not be delivered twice');
    assert.equal(social.conversations.get(aliceOpen.conversation.id).messages[0].text, message.text);

    const outsider = connect(url, 'outsider-id'); clients.push(outsider);
    const outsiderReady = waitFor(outsider, 'social:ready');
    await waitFor(outsider, 'connect'); await outsiderReady;
    const denied = await emitAck(outsider, 'private:open', { friendId: 'alice-id' });
    assert.equal(denied.success, false, 'non-friends must not open private conversations');
    const notJoined = await emitAck(outsider, 'private:send', message);
    assert.equal(notJoined.delivered, false);

    bob.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const offline = await emitAck(alice, 'private:send', { ...message, id: 'message-test-0002' });
    assert.equal(offline.reason, 'recipient_offline', 'no offline queue or false delivery receipt');
    alice.emit('private:leave', { conversationId: aliceOpen.conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(social.conversations.size, 0, 'inactive conversation memory must expire');
    console.log('Social socket tests passed: authenticated presence, multi-device online accounting, accepted-friend authorization, in-memory private delivery, duplicate suppression, offline rejection, and abandoned-chat cleanup.');
  } finally {
    for (const client of clients) client.disconnect();
    social.dispose();
    await new Promise((resolve) => io.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
