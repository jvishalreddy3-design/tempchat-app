'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createAccountService, errorHandler, hashPassword, verifyPassword, safeUser, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('../accounts');

async function run() {
  const hash = await hashPassword('a sufficiently long test password');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, 'a sufficiently long test password'), true);
  assert.equal(await verifyPassword(hash, 'a different password'), false);
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(PASSWORD_MAX_LENGTH, 128);

  const user = { _id: '11111111-1111-1111-1111-111111111111', username: 'tester', displayName: 'Test User', avatarUrl: null, emailVerified: true, passwordHash: hash, email: 'private@example.invalid', googleSub: 'secret-provider-id', createdAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: null };
  const store = {
    users: new Map([['tester', user]]),
    active: true,
    revoked: 0,
    deleted: false,
    findUserByUsername: async (username) => store.users.get(username) || null,
    createUser: async (newUser) => {
      if (store.users.has(newUser.usernameKey)) throw Object.assign(new Error('duplicate'), { code: '23505' });
      store.users.set(newUser.usernameKey, newUser);
      return newUser;
    },
    createSession: async () => {},
    findActiveSession: async () => store.active ? { _id: 'session-test-123' } : null,
    findUserById: async () => user,
    findPublicUser: async (id) => id === user._id ? ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt }) : null,
    countFriends: async () => 2,
    areFriends: async (a, b) => a === user._id && b === user._id,
    updatePassword: async (_id, passwordHash) => { user.passwordHash = passwordHash; return user; },
    revokeAllSessions: async () => { store.revoked += 1; },
    deleteUser: async () => { store.deleted = true; },
  };
  const config = { jwtSecret: 'test-only-secret-that-is-long-enough-1234567890', webOrigin: 'https://example.invalid', email: {} };
  const service = createAccountService({ store, config });
  const valid = service.issueAccess(user._id, 'session-test-123');
  assert.equal((await service.authenticateAccessToken(valid))._id, user._id);
  store.active = false;
  await assert.rejects(() => service.authenticateAccessToken(valid), (error) => error.code === 'session_revoked');
  const expired = jwt.sign({ sub: user._id, sid: 'session-test-123' }, config.jwtSecret, { algorithm: 'HS256', issuer: 'tempchat-api', audience: 'tempchat-client', expiresIn: -1 });
  await assert.rejects(() => service.authenticateAccessToken(expired), (error) => error.code === 'invalid_session');
  const safe = safeUser(user);
  assert.equal(safe.id, user._id);
  assert.equal('passwordHash' in safe, false);
  assert.equal('email' in safe, false);
  assert.equal('googleSub' in safe, false);
  assert.equal(safe.lastSeenAt, null, 'public profiles must expose only the non-sensitive last-seen timestamp');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', service.router);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  try {
    const headers = { 'content-type': 'application/json' };
    let response = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'valid_user', password: '12345678' }) });
    assert.equal(response.status, 201, 'username/password registration must not depend on email delivery');
    const created = store.users.get('valid_user');
    assert.ok(created.passwordHash.startsWith('$argon2id$'));
    assert.equal(created.email, undefined);
    assert.equal(created.emailVerified, true);
    response = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'long_password_user', password: 'a sufficiently long test password' }) });
    assert.equal(response.status, 201, 'passwords longer than 12 characters must be accepted');
    response = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'short_password', password: '1234567' }) });
    assert.equal(response.status, 400, 'passwords shorter than eight characters must be rejected');
    response = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'too_long_password', password: 'a'.repeat(129) }) });
    assert.equal(response.status, 400, 'passwords longer than 128 characters must be rejected');
    response = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'valid_user', password: '12345678' }) });
    assert.equal(response.status, 409, 'duplicate usernames must return a conflict');
    response = await fetch(`${base}/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'long_password_user', password: 'a sufficiently long test password' }) });
    assert.equal(response.status, 200, 'new account must sign in immediately');
    response = await fetch(`${base}/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'valid_user', password: 'incorrect password' }) });
    assert.equal(response.status, 401, 'incorrect password must be rejected');
    response = await fetch(`${base}/google`, { method: 'POST', headers, body: JSON.stringify({ idToken: 'not-a-token' }) });
    assert.equal(response.status, 404, 'Google login route must be unavailable');
    response = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'unknown', password: 'wrong' }) });
    assert.equal(response.status, 401);

    // Authenticated account-management routes.
    store.active = true;
    const access = service.issueAccess(user._id, 'session-test-123');
    const authHeaders = { ...headers, authorization: `Bearer ${access}` };

    response = await fetch(`${base}/username-available?username=tester`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).available, false, 'taken usernames must not be reported as available');

    response = await fetch(`${base}/username-available?username=brand_new`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).available, true);

    response = await fetch(`${base}/users/${user._id}`, { headers: authHeaders });
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.user.username, 'tester');
    assert.equal('passwordHash' in profile.user, false);
    assert.equal('email' in profile.user, false);
    assert.equal(profile.friendsCount, 2);
    assert.equal(profile.isFriend, true);

    response = await fetch(`${base}/change-password`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ currentPassword: 'wrong password', newPassword: 'new test password 123' }) });
    assert.equal(response.status, 401, 'password changes must verify the current password');

    response = await fetch(`${base}/change-password`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ currentPassword: 'a sufficiently long test password', newPassword: 'new test password 123' }) });
    assert.equal(response.status, 200, 'a valid password change must succeed');
    const rotated = await response.json();
    assert.equal(typeof rotated.accessToken, 'string');
    assert.equal(store.revoked, 1, 'changing a password must revoke existing sessions');

    response = await fetch(`${base}/me`, { method: 'DELETE', headers: authHeaders, body: JSON.stringify({ password: 'wrong password' }) });
    assert.equal(response.status, 401, 'account deletion must verify the password');

    response = await fetch(`${base}/me`, { method: 'DELETE', headers: authHeaders, body: JSON.stringify({ password: 'new test password 123' }) });
    assert.equal(response.status, 200, 'a verified account deletion must succeed');
    assert.equal(store.deleted, true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log('Account security tests passed: Argon2id hashing, 8–128 character password policy, username/password registration, duplicate handling, immediate login, incorrect-password rejection, username availability, public profile filtering, password-change session rotation, verified account deletion, revoked sessions, and removed Google route.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
