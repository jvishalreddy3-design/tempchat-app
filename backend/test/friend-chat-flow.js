'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: connectSocket } = require('socket.io-client');
const { createAccountService, errorHandler } = require('../accounts');
const { installSocialSockets } = require('../social-sockets');

function pairKey(a, b) { return [a, b].sort().join(':'); }

// Minimal in-memory store that mirrors the PostgreSQL methods used by the
// account router and the social socket layer. It deliberately has no message
// persistence methods: private chat must remain memory-only.
function createStore() {
  const users = new Map();
  const usersByUsername = new Map();
  const sessions = new Map();
  const sessionsByHash = new Map();
  const friendships = new Set();
  const requests = new Map();

  const publicUser = (user) => ({
    id: user.id,
    _id: user._id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || null,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt || null
  });

  return {
    users,
    friendships,
    requests,
    pairKey,
    async createUser(user) {
      if (usersByUsername.has(user.usernameKey)) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      const stored = { ...user, id: user._id };
      users.set(user._id, stored);
      usersByUsername.set(user.usernameKey, stored);
      return stored;
    },
    async findUserByUsername(usernameKey) { return usersByUsername.get(usernameKey) || null; },
    async findUserById(id) { return users.get(id) || null; },
    async findPublicUser(id) { const user = users.get(id); return user ? publicUser(user) : null; },
    async findUsersByIds(ids) { return ids.map((id) => users.get(id)).filter(Boolean).map(publicUser); },
    async countFriends(id) {
      let count = 0;
      for (const key of friendships) if (key.split(':').includes(id)) count++;
      return count;
    },
    async areFriends(a, b) { return friendships.has(pairKey(a, b)); },
    async createSession(session) {
      sessions.set(session._id, { ...session });
      sessionsByHash.set(session.refreshHash, session._id);
      return session;
    },
    async findActiveSession(sid, userId) {
      const session = sessions.get(sid);
      return session && session.userId === userId && !session.revokedAt && session.expiresAt > new Date() ? session : null;
    },
    async findOneByRefreshHash(refreshHash) {
      const id = sessionsByHash.get(refreshHash);
      const session = id ? sessions.get(id) : null;
      return session && !session.revokedAt && session.expiresAt > new Date() ? session : null;
    },
    async rotateSession(oldHash, replacement) {
      const oldId = sessionsByHash.get(oldHash);
      const previous = oldId ? sessions.get(oldId) : null;
      if (!previous || previous.revokedAt || previous.expiresAt <= new Date()) return null;
      previous.revokedAt = new Date();
      sessions.set(replacement._id, { ...replacement });
      sessionsByHash.set(replacement.refreshHash, replacement._id);
      return previous;
    },
    async revokeByRefreshHash(refreshHash) {
      const id = sessionsByHash.get(refreshHash);
      const session = id ? sessions.get(id) : null;
      if (session) session.revokedAt = new Date();
    },
    async revokeSession(sid, userId) {
      const session = sessions.get(sid);
      if (session && session.userId === userId) session.revokedAt = new Date();
    },
    async revokeAllSessions(userId) {
      for (const session of sessions.values()) if (session.userId === userId) session.revokedAt = new Date();
    },
    async requestFriend(senderId, recipientId) {
      if (friendships.has(pairKey(senderId, recipientId))) return { state: 'already-friends' };
      for (const request of requests.values()) {
        if (request.pairKey !== pairKey(senderId, recipientId) || request.state !== 'pending') continue;
        if (request.senderId === senderId) return { state: 'pending', request };
        return this.acceptRequest(request.id, recipientId, senderId);
      }
      const request = {
        id: crypto.randomUUID(),
        _id: null,
        pairKey: pairKey(senderId, recipientId),
        senderId,
        recipientId,
        state: 'pending',
        createdAt: new Date(),
        respondedAt: null
      };
      request._id = request.id;
      requests.set(request.id, request);
      return { state: 'pending', request };
    },
    async acceptRequest(requestId, recipientId, senderId) {
      const request = requests.get(requestId);
      if (!request || request.recipientId !== recipientId || request.senderId !== senderId || request.state !== 'pending') return null;
      request.state = 'accepted';
      request.respondedAt = new Date();
      friendships.add(request.pairKey);
      return request;
    },
    async respondFriendRequest(requestId, recipientId, accept) {
      const request = requests.get(requestId);
      if (!request || request.recipientId !== recipientId || request.state !== 'pending') return null;
      if (accept) return this.acceptRequest(requestId, request.recipientId, request.senderId);
      request.state = 'declined';
      request.respondedAt = new Date();
      return request;
    },
    async listFriends(id) {
      const friends = [];
      for (const key of friendships) {
        const ids = key.split(':');
        if (!ids.includes(id)) continue;
        const friend = users.get(ids.find((entry) => entry !== id));
        if (friend) friends.push(publicUser(friend));
      }
      return friends;
    },
    async listRequests(id) {
      return [...requests.values()].filter((request) => request.state === 'pending' && (request.senderId === id || request.recipientId === id));
    },
    async setLastSeen() {}
  };
}

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}
function emitAck(socket, event, data, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement`)), timeout);
    socket.emit(event, data, (value) => { clearTimeout(timer); resolve(value); });
  });
}
function connectReady(url, token) {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(url, {
      auth: { accessToken: token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    const timer = setTimeout(() => reject(new Error('Timed out connecting social socket')), 5000);
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('social:ready', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}
function attachCollector(socket) {
  const messages = [];
  socket.on('private:message', (message, acknowledge) => {
    messages.push(message);
    if (typeof acknowledge === 'function') acknowledge({ received: true });
  });
  return messages;
}
function countId(messages, id) {
  return messages.filter((message) => message.id === id).length;
}
function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function openChat(socket, friendId) {
  return emitAck(socket, 'private:open', { friendId });
}
function sendMessage(socket, conversationId, id, text) {
  return emitAck(socket, 'private:send', { conversationId, id, text });
}

async function post(base, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tempchat-client': 'native', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  return { response, data: await response.json() };
}
async function get(base, path, token) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { response, data: await response.json() };
}

async function run() {
  const store = createStore();
  const config = { jwtSecret: 'friend-chat-flow-test-secret-1234567890', webOrigin: 'https://example.invalid', email: {} };
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { transports: ['websocket'] });
  const accountService = createAccountService({ store, config, io });

  app.use(express.json());
  app.use('/api/auth', accountService.router);
  app.use(errorHandler);

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.accessToken;
    if (!token) return next(new Error('authentication required'));
    try {
      const user = await accountService.authenticateAccessToken(String(token));
      socket.accountUser = { id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl || null };
      const claims = jwt.decode(String(token));
      socket.accountAuthExpiresAt = Number(claims?.exp || 0) * 1000;
      next();
    } catch (_) {
      next(new Error('account session expired'));
    }
  });
  const social = installSocialSockets(io, store, accountService, { privateTtlMs: 1000 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/auth`;
  const clients = [];

  try {
    const password = 'flow-test-password';
    for (const username of ['alice_flow', 'bob_flow', 'mallory_flow']) {
      const created = await post(base, '/register', null, { username, password });
      assert.equal(created.response.status, 201, `${username} must register`);
    }
    const aliceLogin = await post(base, '/login', null, { username: 'alice_flow', password });
    const bobLogin = await post(base, '/login', null, { username: 'bob_flow', password });
    const malloryLogin = await post(base, '/login', null, { username: 'mallory_flow', password });
    assert.equal(aliceLogin.response.status, 200);
    assert.equal(bobLogin.response.status, 200);
    assert.equal(malloryLogin.response.status, 200);
    const aliceToken = aliceLogin.data.accessToken;
    const bobToken = bobLogin.data.accessToken;
    const malloryToken = malloryLogin.data.accessToken;
    const aliceId = aliceLogin.data.user.id;
    const bobId = bobLogin.data.user.id;

    let alice = await connectReady(origin, aliceToken); clients.push(alice);
    let bob = await connectReady(origin, bobToken); clients.push(bob);
    const mallory = await connectReady(origin, malloryToken); clients.push(mallory);

    // H. A pending friend request cannot open a private conversation.
    const pendingOpen = await openChat(alice, bobId);
    assert.equal(pendingOpen.success, false, 'pending friends must not be able to open a private chat');
    assert.match(pendingOpen.message, /accepted friends/i);

    const sent = await post(base, '/friend-requests', aliceToken, { username: 'bob_flow' });
    assert.equal(sent.response.status, 200);
    assert.equal(sent.data.state, 'pending');
    const requestId = sent.data.requestId;
    assert.ok(requestId);

    const incoming = await get(base, '/friend-requests', bobToken);
    assert.equal(incoming.response.status, 200);
    const request = incoming.data.requests.find((entry) => entry.id === requestId);
    assert.ok(request, 'the recipient must see the incoming request');
    assert.equal(request.direction, 'incoming');
    assert.equal(request.user.id, aliceId);

    const accepted = await post(base, `/friend-requests/${requestId}/accept`, bobToken, {});
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.data.state, 'accepted');

    const aliceFriends = await get(base, '/friends', aliceToken);
    assert.equal(aliceFriends.response.status, 200);
    assert.equal(aliceFriends.data.friends.some((friend) => friend.id === bobId || friend._id === bobId), true, 'accepted friends must appear in the friend list');
    const bobFriends = await get(base, '/friends', bobToken);
    assert.equal(bobFriends.data.friends.some((friend) => friend.id === aliceId || friend._id === aliceId), true);

    // I. A non-friend cannot open or send to a private conversation.
    const nonFriendOpen = await openChat(mallory, aliceId);
    assert.equal(nonFriendOpen.success, false, 'non-friends must not open private conversations');
    const forgedSend = await sendMessage(mallory, `dm_${'0'.repeat(32)}`, 'friend-flow-forged-0001', 'not allowed');
    assert.equal(forgedSend.delivered, false);
    assert.equal(forgedSend.reason, 'unauthorized', 'a non-participant must never be able to send');

    const aliceMessages = attachCollector(alice);
    const bobMessages = attachCollector(bob);

    // A. Both users online, both open the same chat, messages delivered.
    const aliceOpen = await openChat(alice, bobId);
    assert.equal(aliceOpen.success, true, 'accepted friends must be able to open a private chat');
    assert.deepEqual(aliceOpen.conversation.messages, [], 'reopened chats must not return history');
    const bobOpen = await openChat(bob, aliceId);
    assert.equal(bobOpen.success, true);
    assert.equal(bobOpen.conversation.id, aliceOpen.conversation.id, 'both users must join the same deterministic conversation');
    const conversationId = aliceOpen.conversation.id;

    const a1 = await sendMessage(alice, conversationId, 'friend-flow-a-0001', 'hello one');
    assert.equal(a1.delivered, true, 'accepted friends must be able to exchange messages');
    assert.equal(countId(bobMessages, 'friend-flow-a-0001'), 1);
    assert.equal(countId(aliceMessages, 'friend-flow-a-0001'), 0, 'the sender must not receive their own message');

    // B. Both online, only the sender has opened the chat. This is the
    // production failure that returned "friend is not in this chat".
    bob.emit('private:leave', { conversationId });
    await settle();
    assert.equal(social.conversations.has(conversationId), true, 'the sender must keep the conversation active');
    const a2 = await sendMessage(alice, conversationId, 'friend-flow-a-0002', 'hello while closed');
    assert.equal(a2.delivered, true, 'an online friend who has not opened the chat must still receive the message');
    assert.notEqual(a2.reason, 'recipient_not_in_chat');
    assert.equal(countId(bobMessages, 'friend-flow-a-0002'), 1);
    assert.equal(countId(aliceMessages, 'friend-flow-a-0002'), 0);

    // C. The receiver opens the chat after the sender.
    const bobOpenLate = await openChat(bob, aliceId);
    assert.equal(bobOpenLate.success, true);
    assert.equal(bobOpenLate.conversation.id, conversationId);
    const a3 = await sendMessage(alice, conversationId, 'friend-flow-a-0003', 'hello after opening');
    assert.equal(a3.delivered, true);
    assert.equal(countId(bobMessages, 'friend-flow-a-0003'), 1);
    const b1 = await sendMessage(bob, conversationId, 'friend-flow-b-0001', 'reply from bob');
    assert.equal(b1.delivered, true);
    assert.equal(countId(aliceMessages, 'friend-flow-b-0001'), 1);

    // D. The receiver closes and reopens the chat.
    bob.emit('private:leave', { conversationId });
    await settle();
    assert.equal(social.conversations.has(conversationId), true, 'one participant leaving must not destroy an active conversation');
    const bobReopen = await openChat(bob, aliceId);
    assert.equal(bobReopen.success, true);
    assert.equal(bobReopen.conversation.id, conversationId);
    const a4 = await sendMessage(alice, conversationId, 'friend-flow-a-0004', 'after reopen');
    assert.equal(a4.delivered, true);
    assert.equal(countId(bobMessages, 'friend-flow-a-0004'), 1);

    // E. The sender disconnects and reconnects with a new socket.
    alice.disconnect();
    await settle(80);
    assert.equal(social.conversations.has(conversationId), true, 'the receiver must keep the conversation alive');
    alice = await connectReady(origin, aliceToken); clients.push(alice);
    const aliceMessagesAfterReconnect = attachCollector(alice);
    const aliceReopen = await openChat(alice, bobId);
    assert.equal(aliceReopen.success, true);
    assert.equal(aliceReopen.conversation.id, conversationId);
    const a5 = await sendMessage(alice, conversationId, 'friend-flow-a-0005', 'after sender reconnect');
    assert.equal(a5.delivered, true);
    assert.equal(countId(bobMessages, 'friend-flow-a-0005'), 1);
    assert.equal(countId(aliceMessagesAfterReconnect, 'friend-flow-a-0005'), 0);

    // F. The receiver disconnects and reconnects with a new socket.
    bob.disconnect();
    await settle(80);
    const offline = await sendMessage(alice, conversationId, 'friend-flow-a-0006', 'offline attempt');
    assert.equal(offline.delivered, false, 'an offline receiver must never produce a false delivery receipt');
    assert.equal(offline.reason, 'recipient_offline');
    bob = await connectReady(origin, bobToken); clients.push(bob);
    const bobMessagesAfterReconnect = attachCollector(bob);
    const bobReopenAfterReconnect = await openChat(bob, aliceId);
    assert.equal(bobReopenAfterReconnect.success, true);
    assert.equal(bobReopenAfterReconnect.conversation.id, conversationId);
    const a6 = await sendMessage(alice, conversationId, 'friend-flow-a-0007', 'after receiver reconnect');
    assert.equal(a6.delivered, true);
    assert.equal(countId(bobMessagesAfterReconnect, 'friend-flow-a-0007'), 1);

    // G. Both users have multiple devices connected.
    const bobDevice2 = await connectReady(origin, bobToken); clients.push(bobDevice2);
    const bobDevice2Messages = attachCollector(bobDevice2);
    const bobDevice3 = await connectReady(origin, bobToken); clients.push(bobDevice3);
    const bobDevice3Messages = attachCollector(bobDevice3);
    const aliceDevice2 = await connectReady(origin, aliceToken); clients.push(aliceDevice2);
    const aliceDevice2Messages = attachCollector(aliceDevice2);
    const [bobDevice2Open, bobDevice3Open, aliceDevice2Open] = await Promise.all([
      openChat(bobDevice2, aliceId),
      openChat(bobDevice3, aliceId),
      openChat(aliceDevice2, bobId)
    ]);
    assert.equal(bobDevice2Open.success, true);
    assert.equal(bobDevice3Open.success, true);
    assert.equal(aliceDevice2Open.success, true);
    assert.equal(bobDevice2Open.conversation.id, conversationId);
    assert.equal(bobDevice3Open.conversation.id, conversationId);
    assert.equal(aliceDevice2Open.conversation.id, conversationId);

    const a7 = await sendMessage(alice, conversationId, 'friend-flow-a-0008', 'multi device');
    assert.equal(a7.delivered, true);
    assert.equal(countId(bobMessagesAfterReconnect, 'friend-flow-a-0008'), 1);
    assert.equal(countId(bobDevice2Messages, 'friend-flow-a-0008'), 1, 'each recipient device must receive one copy');
    assert.equal(countId(bobDevice3Messages, 'friend-flow-a-0008'), 1, 'each recipient device must receive one copy');
    assert.equal(countId(aliceDevice2Messages, 'friend-flow-a-0008'), 0, 'a sender device must not receive the sender message');

    // L. No duplicate delivery when the same message ID is retried.
    const duplicate = await sendMessage(alice, conversationId, 'friend-flow-a-0008', 'multi device');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivered, true);
    assert.equal(countId(bobMessagesAfterReconnect, 'friend-flow-a-0008'), 1);
    assert.equal(countId(bobDevice2Messages, 'friend-flow-a-0008'), 1);
    assert.equal(countId(bobDevice3Messages, 'friend-flow-a-0008'), 1);

    // J. Repeated exchange in both directions without delivery failures.
    for (let index = 0; index < 6; index += 1) {
      const aliceMessageId = `friend-flow-j-a-${String(index).padStart(3, '0')}`;
      const bobMessageId = `friend-flow-j-b-${String(index).padStart(3, '0')}`;
      const fromAlice = await sendMessage(alice, conversationId, aliceMessageId, `alice ${index}`);
      assert.equal(fromAlice.delivered, true, `alice message ${index} must be delivered`);
      assert.equal(countId(bobMessagesAfterReconnect, aliceMessageId), 1);
      const fromBob = await sendMessage(bob, conversationId, bobMessageId, `bob ${index}`);
      assert.equal(fromBob.delivered, true, `bob message ${index} must be delivered`);
      assert.equal(countId(aliceMessagesAfterReconnect, bobMessageId), 1);
    }

    // K. Cleanup must not destroy a conversation while another participant is
    // still active, and must destroy it once the last participant leaves.
    const storedConversation = social.conversations.get(conversationId);
    assert.ok(storedConversation, 'the active conversation must still exist');
    const storedIds = storedConversation.messages.map((message) => message.id);
    assert.equal(new Set(storedIds).size, storedIds.length, 'the server must not store duplicate message IDs');

    bob.emit('private:leave', { conversationId });
    bobDevice2.emit('private:leave', { conversationId });
    bobDevice3.emit('private:leave', { conversationId });
    await settle();
    assert.equal(social.conversations.has(conversationId), true, 'an active sender must keep the conversation alive');

    aliceDevice2.emit('private:leave', { conversationId });
    await settle();
    assert.equal(social.conversations.has(conversationId), true, 'one remaining participant must keep the conversation alive');

    alice.emit('private:leave', { conversationId });
    await settle();
    assert.equal(social.conversations.has(conversationId), false, 'the conversation must be cleaned up after the last participant leaves');

    assert.equal(store.savedMessages, undefined, 'the flow test store has no message persistence methods');
    console.log('Friend chat flow tests passed: pending/non-friend rejection, same-conversation initialization, delivery to an online friend who has not opened the chat, receiver open/reopen, sender and receiver reconnect, multi-device fan-out, duplicate suppression, repeated exchange, truthful delivery receipts, and non-destructive cleanup.');
  } finally {
    for (const client of clients) client.disconnect();
    social.dispose();
    await new Promise((resolve) => io.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
