'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { createAccountService, errorHandler, hashPassword } = require('../accounts');
const { PgStore } = require('../pg-store');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(req, _res, next) {
  req.cookies = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    try {
      req.cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch (_) {}
  }
  next();
}

function getRefreshCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'refresh responses must set a cookie for web clients');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Path=\/api\/auth/i);
  const pair = header.split(';', 1)[0];
  const index = pair.indexOf('=');
  assert.ok(index > 0);
  return pair.slice(index + 1);
}

function createRefreshStore(user) {
  const sessions = new Map();
  const rotations = [];
  return {
    sessions,
    rotations,
    findUserByUsername: async (usernameKey) => usernameKey === user.usernameKey ? user : null,
    findUserById: async (userId) => userId === user._id ? user : null,
    createSession: async (session) => {
      sessions.set(session.refreshHash, { ...session });
      return session;
    },
    findActiveSession: async (sid, userId) => {
      for (const session of sessions.values()) {
        if (session._id === sid && session.userId === userId && !session.revokedAt && session.expiresAt > new Date()) return session;
      }
      return null;
    },
    findOneByRefreshHash: async (refreshHash) => {
      const session = sessions.get(refreshHash);
      return session && !session.revokedAt && session.expiresAt > new Date() ? session : null;
    },
    rotateSession: async (oldHash, replacement) => {
      const previous = sessions.get(oldHash);
      if (!previous || previous.revokedAt || previous.expiresAt <= new Date()) return null;
      previous.revokedAt = new Date();
      sessions.set(oldHash, previous);
      sessions.set(replacement.refreshHash, { ...replacement });
      rotations.push(replacement);
      return previous;
    },
    revokeByRefreshHash: async (refreshHash) => {
      const session = sessions.get(refreshHash);
      if (session) session.revokedAt = new Date();
    },
    revokeSession: async (sid, userId) => {
      for (const session of sessions.values()) {
        if (session._id === sid && session.userId === userId && !session.revokedAt) session.revokedAt = new Date();
      }
    },
    revokeAllSessions: async (userId) => {
      for (const session of sessions.values()) {
        if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date();
      }
    },
  };
}

async function testPgSessionNormalization() {
  const userId = '11111111-1111-1111-1111-111111111111';
  const sessionId = '22222222-2222-2222-2222-222222222222';
  const replacementId = '33333333-3333-3333-3333-333333333333';
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const expiresAt = new Date('2026-02-01T00:00:00Z');
  const row = {
    id: sessionId,
    user_id: userId,
    refresh_hash: 'old-refresh-hash',
    created_at: createdAt,
    expires_at: expiresAt,
    revoked_at: null,
    user_agent: 'refresh-test',
    replaced_by: null,
  };
  const readStore = new PgStore({
    query: async () => ({ rows: [row] }),
  });

  const found = await readStore.findOneByRefreshHash('old-refresh-hash');
  assert.equal(found.id, sessionId);
  assert.equal(found._id, sessionId);
  assert.equal(found.userId, userId);
  assert.equal(found.refreshHash, 'old-refresh-hash');
  assert.equal(found.createdAt.getTime(), createdAt.getTime());
  assert.equal(found.expiresAt.getTime(), expiresAt.getTime());
  assert.equal(found.revokedAt, null);
  assert.equal(found.userAgent, 'refresh-test');
  assert.equal('user_id' in found, false);

  const active = await readStore.findActiveSession(sessionId, userId);
  assert.equal(active.userId, userId);
  assert.equal(active.refreshHash, 'old-refresh-hash');

  const queries = [];
  const rotationStore = new PgStore({
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return sql.includes('SELECT * FROM auth_sessions') ? { rows: [row] } : { rows: [] };
      },
      release: () => {},
    }),
  });
  const replacement = {
    _id: replacementId,
    userId,
    refreshHash: 'new-refresh-hash',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    expiresAt: new Date('2026-02-02T00:00:00Z'),
    revokedAt: null,
    userAgent: 'refresh-test',
  };
  const rotated = await rotationStore.rotateSession('old-refresh-hash', replacement);
  assert.equal(rotated.userId, userId);
  assert.equal(rotated.refreshHash, 'old-refresh-hash');
  const insert = queries.find((query) => query.sql.includes('INSERT INTO auth_sessions'));
  assert.ok(insert, 'rotation must insert the replacement session');
  assert.equal(insert.params[0], replacementId);
  assert.equal(insert.params[1], userId);
  assert.equal(insert.params[2], 'new-refresh-hash');
}

async function testRefreshRoutes() {
  const password = 'refresh-test-password';
  const user = {
    _id: '11111111-1111-1111-1111-111111111111',
    username: 'refresh_user',
    usernameKey: 'refresh_user',
    passwordHash: await hashPassword(password),
    displayName: 'Refresh User',
    avatarUrl: null,
    emailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: null,
  };
  const store = createRefreshStore(user);
  const config = { jwtSecret: 'refresh-test-secret-that-is-long-enough-1234567890' };
  const service = createAccountService({ store, config });
  const app = express();
  app.use(express.json());
  app.use(parseCookies);
  app.use('/api/auth', service.router);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;

  const post = (path, { headers = {}, body = {} } = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const webLogin = async () => {
    const response = await post('/login', { body: { username: user.username, password } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(typeof payload.accessToken, 'string');
    assert.equal(payload.refreshToken, undefined);
    return { response, payload, cookie: getRefreshCookie(response) };
  };

  try {
    const first = await webLogin();
    const firstRefresh = await post('/refresh', { headers: { cookie: `tempchat_refresh=${first.cookie}` } });
    assert.equal(firstRefresh.status, 200);
    const refreshed = await firstRefresh.json();
    assert.equal(typeof refreshed.accessToken, 'string');
    assert.equal(refreshed.refreshToken, undefined);
    const secondCookie = getRefreshCookie(firstRefresh);
    assert.notEqual(secondCookie, first.cookie);
    assert.equal(store.rotations.length, 1);
    assert.equal(store.rotations[0].userId, user._id);

    const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${refreshed.accessToken}` } });
    assert.equal(me.status, 200);

    const reused = await post('/refresh', { headers: { cookie: `tempchat_refresh=${first.cookie}` } });
    assert.equal(reused.status, 401);
    assert.equal((await reused.json()).error.code, 'refresh_expired');

    const nextRefresh = await post('/refresh', { headers: { cookie: `tempchat_refresh=${secondCookie}` } });
    assert.equal(nextRefresh.status, 200);
    assert.notEqual(getRefreshCookie(nextRefresh), secondCookie);
    assert.equal(store.rotations.length, 2);

    const expiredLogin = await webLogin();
    const expiredSession = store.sessions.get(sha256(expiredLogin.cookie));
    assert.ok(expiredSession);
    expiredSession.expiresAt = new Date(Date.now() - 1000);
    const expiredRefresh = await post('/refresh', { headers: { cookie: `tempchat_refresh=${expiredLogin.cookie}` } });
    assert.equal(expiredRefresh.status, 401);
    assert.equal((await expiredRefresh.json()).error.code, 'refresh_expired');

    const revokedLogin = await webLogin();
    const revokedSession = store.sessions.get(sha256(revokedLogin.cookie));
    assert.ok(revokedSession);
    revokedSession.revokedAt = new Date();
    const revokedRefresh = await post('/refresh', { headers: { cookie: `tempchat_refresh=${revokedLogin.cookie}` } });
    assert.equal(revokedRefresh.status, 401);
    assert.equal((await revokedRefresh.json()).error.code, 'refresh_expired');

    const nativeLogin = await post('/login', { headers: { 'x-tempchat-client': 'native' }, body: { username: user.username, password } });
    assert.equal(nativeLogin.status, 200);
    assert.equal(nativeLogin.headers.get('set-cookie'), null);
    const nativePayload = await nativeLogin.json();
    assert.equal(typeof nativePayload.refreshToken, 'string');
    const nativeRefresh = await post('/refresh', {
      headers: { 'x-tempchat-client': 'native' },
      body: { refreshToken: nativePayload.refreshToken },
    });
    assert.equal(nativeRefresh.status, 200);
    assert.equal(nativeRefresh.headers.get('set-cookie'), null);
    const nativeRefreshed = await nativeRefresh.json();
    assert.equal(typeof nativeRefreshed.accessToken, 'string');
    assert.equal(typeof nativeRefreshed.refreshToken, 'string');
    assert.notEqual(nativeRefreshed.refreshToken, nativePayload.refreshToken);
    assert.equal(store.rotations.at(-1).userId, user._id);

    const nativeReused = await post('/refresh', {
      headers: { 'x-tempchat-client': 'native' },
      body: { refreshToken: nativePayload.refreshToken },
    });
    assert.equal(nativeReused.status, 401);
    assert.equal((await nativeReused.json()).error.code, 'refresh_expired');

    const missing = await post('/refresh', { headers: { 'x-tempchat-client': 'native' } });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'refresh_required');

    for (const rotation of store.rotations) assert.equal(rotation.userId, user._id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  await testPgSessionNormalization();
  await testRefreshRoutes();
  console.log('Session refresh tests passed: PostgreSQL field normalization, web HttpOnly cookie refresh, native refresh-token rotation, expired tokens, revoked sessions, and replacement userId.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
