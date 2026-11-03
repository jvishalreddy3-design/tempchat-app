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
      if (accept) return this.acceptRequest(requestId, recipientId, request.senderId);
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

function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}
function emitAck(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}
function connect(url, token) {
  return connectSocket(url, { auth: { accessToken: token }, transports: ['websocket'], forceNew: true, reconnection: false });
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
    for (const username of ['alice_flow', 'bob_flow']) {
      const created = await post(base, '/register', null, { username, password: 'flow-test-password' });
      assert.equal(created.response.status, 201, `${username} must register`);
    }
    const aliceLogin = await post(base, '/login', null, { username: 'alice_flow', password: 'flow-test-password' });
    const bobLogin = await post(base, '/login', null, { username: 'bob_flow', password: 'flow-test-password' });
    assert.equal(aliceLogin.response.status, 200);
    assert.equal(bobLogin.response.status, 200);
    const aliceToken = aliceLogin.data.accessToken;
    const bobToken = bobLogin.data.accessToken;
    const aliceId = aliceLogin.data.user.id;
    const bobId = bobLogin.data.user.id;

    const alice = connect(origin, aliceToken); clients.push(alice);
    const bob = connect(origin, bobToken); clients.push(bob);
    const aliceReady = waitFor(alice, 'social:ready');
    const bobReady = waitFor(bob, 'social:ready');
    await waitFor(alice, 'connect');
    await waitFor(bob, 'connect');
    await aliceReady;
    await bobReady;

    const beforeAccept = await emitAck(alice, 'private:open', { friendId: bobId });
    assert.equal(beforeAccept.success, false, 'pending friends must not be able to open a private chat');
    assert.match(beforeAccept.message, /accepted friends/i);

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

    const aliceOpen = await emitAck(alice, 'private:open', { friendId: bobId });
    assert.equal(aliceOpen.success, true, 'accepted friends must be able to open a private chat');
    assert.deepEqual(aliceOpen.conversation.messages, [], 'reopened chats must not return history');
    const bobOpen = await emitAck(bob, 'private:open', { friendId: aliceId });
    assert.equal(bobOpen.success, true);
    assert.equal(bobOpen.conversation.id, aliceOpen.conversation.id);

    let received = null;
    bob.on('private:message', (message, acknowledge) => { received = message; acknowledge({ received: true }); });
    const delivery = await emitAck(alice, 'private:send', {
      conversationId: aliceOpen.conversation.id,
      id: 'friend-flow-message-0001',
      text: 'hello from the friend flow'
    });
    assert.equal(delivery.delivered, true, 'accepted friends must be able to exchange messages');
    assert.equal(received.text, 'hello from the friend flow');
    assert.equal(store.savedMessages, undefined, 'the flow test store has no message persistence methods');

    console.log('Friend chat flow tests passed: pending requests cannot open private chat, accepted friends appear in both friend lists, and accepted friends can open the same ephemeral conversation and exchange a message.');
  } finally {
    for (const client of clients) client.disconnect();
    social.dispose();
    await new Promise((resolve) => io.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
