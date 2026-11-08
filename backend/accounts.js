'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const jwt = require('jsonwebtoken');
const argon2 = require('@node-rs/argon2');

const ACCESS_TTL_SECONDS = 10 * 60;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HASH_OPTIONS = { algorithm: argon2.Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function safeUser(user) {
  if (!user) return null;
  return { id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl || null, emailVerified: Boolean(user.emailVerified), createdAt: user.createdAt, lastSeenAt: user.lastSeenAt || null };
}
function authError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

function createAccountService({ store, config, io }) {
  function issueAccess(userId, sessionId) {
    return jwt.sign({ sub: userId, sid: sessionId }, config.jwtSecret, { algorithm: 'HS256', issuer: 'tempchat-api', audience: 'tempchat-client', expiresIn: ACCESS_TTL_SECONDS });
  }
  async function makeSession(user, req, res) {
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await store.createSession({ _id: sessionId, userId: user._id, refreshHash: sha256(refreshToken), createdAt: new Date(), expiresAt, revokedAt: null, userAgent: String(req.get('user-agent') || '').slice(0, 256) });
    const native = req.get('x-tempchat-client') === 'native';
    if (!native) res.cookie('tempchat_refresh', refreshToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth', maxAge: SESSION_TTL_MS });
    return { accessToken: issueAccess(user._id, sessionId), expiresIn: ACCESS_TTL_SECONDS, ...(native ? { refreshToken } : {}), user: safeUser(user) };
  }
  async function authenticateAccessToken(token) {
    let claims;
    try { claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'tempchat-api', audience: 'tempchat-client' }); }
    catch (_) { throw authError(401, 'invalid_session', 'Sign in again to continue.'); }
    if (!claims.sid || !claims.sub || !(await store.findActiveSession(claims.sid, claims.sub))) throw authError(401, 'session_revoked', 'This session has expired. Sign in again.');
    const user = await store.findUserById(claims.sub);
    if (!user) throw authError(401, 'account_unavailable', 'This account is unavailable.');
    return user;
  }
  function middleware({ verified = false } = {}) {
    return async (req, res, next) => {
      try {
        const value = req.get('authorization') || '';
        const token = value.startsWith('Bearer ') ? value.slice(7) : '';
        if (!token) throw authError(401, 'authentication_required', 'Sign in to continue.');
        req.user = await authenticateAccessToken(token);
        try { req.sessionId = jwt.decode(token)?.sid || null; } catch (_) { req.sessionId = null; }
        next();
      } catch (error) { next(error); }
    };
  }

  const router = Router();

  // Lightweight in-memory throttle for credential endpoints. It complements
  // (and does not replace) edge-level rate limiting, and needs no dependency.
  const authAttempts = new Map();
  function allowAttempt(key, limit, windowMs) {
    const now = Date.now();
    if (authAttempts.size > 10000) {
      for (const [entryKey, entry] of authAttempts) {
        if (now - entry.startedAt >= windowMs) authAttempts.delete(entryKey);
      }
    }
    const entry = authAttempts.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      authAttempts.set(key, { startedAt: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }
  function throttle(limit, windowMs) {
    return (req, _res, next) => {
      const key = `${req.ip || 'unknown'}:${req.method}:${req.path}`;
      if (!allowAttempt(key, limit, windowMs)) {
        return next(authError(429, 'rate_limited', 'Too many attempts. Wait a moment and try again.'));
      }
      next();
    };
  }
  async function notifyFriendPresence(firstId, secondId) {
    if (!io) return;
    try {
      const firstOnline = (await io.in('account:' + firstId).fetchSockets()).length > 0;
      const secondOnline = (await io.in('account:' + secondId).fetchSockets()).length > 0;
      io.to('account:' + firstId).emit('friends:presence', { userId: secondId, online: secondOnline, observedAt: new Date().toISOString() });
      io.to('account:' + secondId).emit('friends:presence', { userId: firstId, online: firstOnline, observedAt: new Date().toISOString() });
    } catch (_) { /* Presence is refreshed when either account reconnects. */ }
  }
  router.get('/username-available', async (req, res, next) => {
    try {
      const username = String(req.query?.username || '').trim();
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ available: false, error: { code: 'invalid_username', message: 'Username must be 3–24 characters using letters, numbers, or underscores.' } });
      }
      const existing = await store.findUserByUsername(username.toLowerCase());
      res.json({ available: !existing, username });
    } catch (error) { next(error); }
  });
  router.post('/register', throttle(10, 60 * 60 * 1000), async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim();
      const usernameKey = username.toLowerCase();
      const password = String(req.body?.password || '');
      if (!USERNAME_RE.test(username)) throw authError(400, 'invalid_username', 'Username must be 3–24 characters using letters, numbers, or underscores.');
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) throw authError(400, 'weak_password', `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
      const user = {
        _id: crypto.randomUUID(), username, usernameKey,
        passwordHash: await argon2.hash(password, HASH_OPTIONS), googleSub: null,
        displayName: username,
        avatarUrl: null, emailVerified: true, createdAt: new Date(), updatedAt: new Date()
      };
      await store.createUser(user);
      res.status(201).json({ success: true, message: 'Account created. Sign in with your username and password.' });
    } catch (error) { next(error.code === '23505' ? authError(409, 'account_exists', 'That username is already registered.') : error); }
  });
  router.post('/login', throttle(20, 10 * 60 * 1000), async (req, res, next) => {
    try {
      const usernameKey = String(req.body?.username || '').trim().toLowerCase();
      const user = await store.findUserByUsername(usernameKey);
      const valid = user?.passwordHash ? await argon2.verify(user.passwordHash, String(req.body?.password || '')) : false;
      if (!valid) throw authError(401, 'invalid_credentials', 'Username or password is incorrect.');
      res.json(await makeSession(user, req, res));
    } catch (error) { next(error); }
  });
  router.post('/refresh', throttle(120, 10 * 60 * 1000), async (req, res, next) => {
    try {
      const native = req.get('x-tempchat-client') === 'native';
      const oldToken = native ? String(req.body?.refreshToken || '') : String(req.cookies?.tempchat_refresh || '');
      if (!oldToken) throw authError(401, 'refresh_required', 'Your session expired. Sign in again.');
      const session = await store.findOneByRefreshHash(sha256(oldToken));
      if (!session || session.revokedAt || session.expiresAt <= new Date()) throw authError(401, 'refresh_expired', 'Your session expired. Sign in again.');
      const user = await store.findUserById(session.userId);
      if (!user) throw authError(401, 'account_unavailable', 'Sign in again to continue.');
      const refreshToken = randomToken();
      const replacementId = crypto.randomUUID();
      const rotated = await store.rotateSession(sha256(oldToken), { _id: replacementId, userId: session.userId, refreshHash: sha256(refreshToken), createdAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), revokedAt: null, userAgent: String(req.get('user-agent') || '').slice(0, 256) });
      if (!rotated) throw authError(401, 'refresh_reused', 'Your session expired. Sign in again.');
      if (!native) res.cookie('tempchat_refresh', refreshToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth', maxAge: SESSION_TTL_MS });
      res.json({ accessToken: issueAccess(user._id, replacementId), expiresIn: ACCESS_TTL_SECONDS, ...(native ? { refreshToken } : {}), user: safeUser(user) });
    } catch (error) { next(error); }
  });
  router.post('/logout', async (req, res, next) => {
    try {
      const native = req.get('x-tempchat-client') === 'native';
      if (native) {
        const value = req.get('authorization') || '';
        const token = value.startsWith('Bearer ') ? value.slice(7) : '';
        if (token) {
          const user = await authenticateAccessToken(token);
          const claims = jwt.decode(token);
          await store.revokeSession(claims.sid, user._id);
        }
        if (req.body?.refreshToken) await store.revokeByRefreshHash(sha256(String(req.body.refreshToken)));
      } else if (req.cookies?.tempchat_refresh) await store.revokeByRefreshHash(sha256(req.cookies.tempchat_refresh));
      res.clearCookie('tempchat_refresh', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth' });
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  router.get('/me', middleware(), (req, res) => res.json({ user: safeUser(req.user) }));

  // -------------------------------------------------------------------------
  // Sessions and login activity
  // -------------------------------------------------------------------------
  router.get('/sessions', middleware({ verified: true }), async (req, res, next) => {
    try {
      const sessions = await store.listActiveSessions(req.user._id);
      res.json({
        sessions: sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          userAgent: session.userAgent,
          current: session.id === req.sessionId
        }))
      });
    } catch (error) { next(error); }
  });
  router.delete('/sessions/:id', middleware({ verified: true }), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw authError(400, 'invalid_session', 'That session could not be found.');
      }
      await store.revokeSession(sessionId, req.user._id);
      if (sessionId === req.sessionId) {
        res.clearCookie('tempchat_refresh', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth' });
      }
      res.json({ success: true, current: sessionId === req.sessionId });
    } catch (error) { next(error); }
  });
  router.post('/sessions/logout-all', middleware({ verified: true }), async (req, res, next) => {
    try {
      await store.revokeAllSessions(req.user._id);
      io?.in('account:' + req.user._id).disconnectSockets(true);
      res.clearCookie('tempchat_refresh', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth' });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  // -------------------------------------------------------------------------
  // Privacy settings
  // -------------------------------------------------------------------------
  const ONLINE_VISIBILITY = new Set(['everyone', 'friends', 'nobody']);
  const REQUEST_POLICY = new Set(['everyone', 'nobody']);
  router.get('/privacy', middleware({ verified: true }), async (req, res, next) => {
    try { res.json({ privacy: await store.getPrivacySettings(req.user._id) }); } catch (error) { next(error); }
  });
  router.patch('/privacy', middleware({ verified: true }), async (req, res, next) => {
    try {
      const update = {};
      if (req.body?.onlineStatusVisibility !== undefined) {
        const value = String(req.body.onlineStatusVisibility);
        if (!ONLINE_VISIBILITY.has(value)) throw authError(400, 'invalid_privacy', 'Choose who can see your online status.');
        update.onlineStatusVisibility = value;
      }
      if (req.body?.friendRequestPolicy !== undefined) {
        const value = String(req.body.friendRequestPolicy);
        if (!REQUEST_POLICY.has(value)) throw authError(400, 'invalid_privacy', 'Choose who can send you friend requests.');
        update.friendRequestPolicy = value;
      }
      res.json({ privacy: await store.updatePrivacySettings(req.user._id, update) });
    } catch (error) { next(error); }
  });

  // -------------------------------------------------------------------------
  // Blocks and reports
  // -------------------------------------------------------------------------
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REPORT_REASONS = new Set(['spam', 'harassment', 'impersonation', 'inappropriate', 'other']);
  router.get('/blocks', middleware({ verified: true }), async (req, res, next) => {
    try { res.json({ blocked: await store.listBlockedUsers(req.user._id) }); } catch (error) { next(error); }
  });
  router.post('/users/:id/block', middleware({ verified: true }), async (req, res, next) => {
    try {
      const userId = String(req.params.id || '');
      if (!UUID_RE.test(userId) || userId === req.user._id) throw authError(400, 'invalid_user', 'That account cannot be blocked.');
      const target = await store.findUserById(userId);
      if (!target) throw authError(404, 'user_not_found', 'That user could not be found.');
      await store.blockUser(req.user._id, userId);
      // PgStore removes the friendship and pending request atomically inside
      // blockUser, so a partial failure cannot leave friends-only access.
      io?.to('account:' + req.user._id).emit('social:changed');
      io?.to('account:' + userId).emit('social:changed');
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  router.delete('/users/:id/block', middleware({ verified: true }), async (req, res, next) => {
    try {
      const userId = String(req.params.id || '');
      if (!UUID_RE.test(userId)) throw authError(400, 'invalid_user', 'That account could not be found.');
      await store.unblockUser(req.user._id, userId);
      io?.to('account:' + req.user._id).emit('social:changed');
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  router.post('/users/:id/report', middleware({ verified: true }), async (req, res, next) => {
    try {
      // Reports are persisted in the database, so throttle both the reporting
      // account and the source address to protect the moderation queue.
      if (!allowAttempt(`report:${req.user._id}`, 20, 60 * 60 * 1000)
        || !allowAttempt(`report-ip:${req.ip || 'unknown'}`, 40, 60 * 60 * 1000)) {
        throw authError(429, 'rate_limited', 'Too many reports. Wait a moment and try again.');
      }
      const userId = String(req.params.id || '');
      if (!UUID_RE.test(userId) || userId === req.user._id) throw authError(400, 'invalid_user', 'That account cannot be reported.');
      const reason = String(req.body?.reason || 'other');
      if (!REPORT_REASONS.has(reason)) throw authError(400, 'invalid_reason', 'Choose a valid report reason.');
      const details = req.body?.details == null ? null : String(req.body.details).slice(0, 1000);
      const target = await store.findUserById(userId);
      if (!target) throw authError(404, 'user_not_found', 'That user could not be found.');
      const report = await store.createReport(req.user._id, userId, reason, details);
      res.status(201).json({ success: true, report });
    } catch (error) { next(error); }
  });

  router.get('/users/search', middleware({ verified: true }), async (req, res, next) => {
    try {
      const q = String(req.query?.q || '').trim().toLowerCase();
      if (!q || q.length < 2) {
        return res.status(400).json({ error: { code: 'invalid_query', message: 'Enter at least 2 characters to search.' } });
      }
      const users = await store.searchUsers(q, 20);
      res.json({ users: users.filter((user) => user.id !== req.user._id) });
    } catch (error) { next(error); }
  });
  router.get('/users/:id', middleware({ verified: true }), async (req, res, next) => {
    try {
      const userId = String(req.params.id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw authError(400, 'invalid_user', 'That user could not be found.');
      const profile = await store.findPublicUser(userId);
      if (!profile) throw authError(404, 'user_not_found', 'That user could not be found.');
      const [friendsCount, isFriend, blocked] = await Promise.all([
        store.countFriends(userId),
        store.areFriends(req.user._id, userId),
        typeof store.isBlocked === 'function' ? store.isBlocked(req.user._id, userId) : Promise.resolve(false)
      ]);
      // Online status and last-seen follow the profile owner's privacy choice.
      const visibility = profile.onlineStatusVisibility || 'friends';
      const canSeePresence = visibility === 'everyone' || (visibility === 'friends' && isFriend);
      const online = canSeePresence && io ? (await io.in('account:' + userId).fetchSockets()).length > 0 : false;
      const publicProfile = {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        createdAt: profile.createdAt,
        lastSeenAt: canSeePresence ? profile.lastSeenAt : null,
        online,
        presenceVisible: canSeePresence
      };
      res.json({ user: publicProfile, friendsCount, isFriend, blocked });
    } catch (error) { next(error); }
  });
  router.patch('/me', middleware({ verified: true }), async (req, res, next) => {
    try {
      const displayName = String(req.body?.displayName || '').trim();
      const avatarUrl = req.body?.avatarUrl == null || req.body.avatarUrl === '' ? null : String(req.body.avatarUrl);
      if (!displayName || displayName.length > 48) throw authError(400, 'invalid_profile', 'Display name must be between 1 and 48 characters.');
      if (avatarUrl && (!/^https:\/\//i.test(avatarUrl) || avatarUrl.length > 2048)) throw authError(400, 'invalid_avatar', 'Avatar must be an HTTPS URL under 2048 characters.');
      const updated = await store.updateUser(req.user._id, { displayName, avatarUrl, updatedAt: new Date() });
      res.json({ user: safeUser(updated) });
    } catch (error) { next(error); }
  });
  router.post('/change-password', middleware({ verified: true }), async (req, res, next) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');
      if (!req.user.passwordHash || !(await argon2.verify(req.user.passwordHash, currentPassword))) {
        throw authError(401, 'invalid_password', 'Current password is incorrect.');
      }
      if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
        throw authError(400, 'weak_password', `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
      }
      if (newPassword === currentPassword) throw authError(400, 'same_password', 'Choose a password different from your current one.');
      await store.updatePassword(req.user._id, await argon2.hash(newPassword, HASH_OPTIONS));
      await store.revokeAllSessions(req.user._id);
      const user = await store.findUserById(req.user._id);
      res.json(await makeSession(user, req, res));
    } catch (error) { next(error); }
  });
  router.delete('/me', middleware({ verified: true }), async (req, res, next) => {
    try {
      const password = String(req.body?.password || '');
      if (!req.user.passwordHash || !(await argon2.verify(req.user.passwordHash, password))) {
        throw authError(401, 'invalid_password', 'Password is incorrect.');
      }
      await store.deleteUser(req.user._id);
      io?.in('account:' + req.user._id).disconnectSockets(true);
      res.clearCookie('tempchat_refresh', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth' });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  router.get('/friends', middleware({ verified: true }), async (req, res, next) => {
    try { res.json({ friends: await store.listFriends(req.user._id) }); } catch (error) { next(error); }
  });
  router.get('/friend-requests', middleware({ verified: true }), async (req, res, next) => {
    try {
      const requests = await store.listRequests(req.user._id);
      const ids = [...new Set(requests.map((r) => r.senderId === req.user._id ? r.recipientId : r.senderId))];
      const users = await store.findUsersByIds(ids);
      res.json({ requests: requests.map((r) => ({ id: r._id, state: r.state, direction: r.senderId === req.user._id ? 'outgoing' : 'incoming', createdAt: r.createdAt, user: safeUser(users.find((u) => u.id === (r.senderId === req.user._id ? r.recipientId : r.senderId))) })) });
    } catch (error) { next(error); }
  });
  router.post('/friend-requests', middleware({ verified: true }), async (req, res, next) => {
    try {
      const usernameKey = String(req.body?.username || '').trim().toLowerCase();
      const target = await store.findUserByUsername(usernameKey);
      if (!target) throw authError(404, 'user_not_found', 'No account matches that username.');
      if (target._id === req.user._id) throw authError(400, 'self_friendship', 'You cannot add yourself as a friend.');
      if (typeof store.isBlocked === 'function' && await store.isBlocked(req.user._id, target._id)) throw authError(403, 'blocked', 'You cannot send a friend request to this account.');
      if ((target.friendRequestPolicy || 'everyone') === 'nobody') throw authError(403, 'requests_disabled', 'This account is not accepting friend requests.');
      const result = await store.requestFriend(req.user._id, target._id);
      const status = result.state === 'pending' ? 'pending' : result.state;
      if (status === 'pending' || status === 'accepted') {
        if (status === 'pending') {
          io?.to('account:' + target._id).emit('friends:request', {
            requestId: result.request?._id || null,
            sender: safeUser(req.user),
            createdAt: result.request?.createdAt || new Date().toISOString()
          });
        }
        io?.to('account:' + target._id).emit('social:changed');
        if (status === 'accepted') io?.to('account:' + req.user._id).emit('social:changed');
      }
      if (status === 'accepted' || status === 'already-friends') await notifyFriendPresence(req.user._id, target._id);
      if (status === 'conflict') return res.status(409).json({ error: { code: 'request_conflict', message: 'A request between these accounts is already pending. Refresh your requests to respond.' } });
      res.status(200).json({ success: true, state: status, requestId: result.request?._id });
    } catch (error) { next(error); }
  });
  router.post('/friend-requests/:id/accept', middleware({ verified: true }), async (req, res, next) => {
    try {
      const request = await store.respondFriendRequest(String(req.params.id), req.user._id, true);
      if (!request) throw authError(404, 'request_unavailable', 'That request is no longer pending.');
      io?.to('account:' + request.senderId).emit('social:changed');
      io?.to('account:' + req.user._id).emit('social:changed');
      await notifyFriendPresence(req.user._id, request.senderId);
      res.json({ success: true, state: 'accepted' });
    } catch (error) { next(error); }
  });
  router.post('/friend-requests/:id/decline', middleware({ verified: true }), async (req, res, next) => {
    try {
      const request = await store.respondFriendRequest(String(req.params.id), req.user._id, false);
      if (!request) throw authError(404, 'request_unavailable', 'That request is no longer pending.');
      io?.to('account:' + request.senderId).emit('social:changed');
      res.json({ success: true, state: 'declined' });
    } catch (error) { next(error); }
  });
  router.delete('/friend-requests/:id', middleware({ verified: true }), async (req, res, next) => {
    try {
      const request = await store.cancelFriendRequest(String(req.params.id), req.user._id);
      if (!request) throw authError(404, 'request_unavailable', 'That outgoing request is no longer pending.');
      io?.to('account:' + request.recipientId).emit('social:changed');
      res.json({ success: true, state: 'cancelled' });
    } catch (error) { next(error); }
  });
  router.delete('/friends/:userId', middleware({ verified: true }), async (req, res, next) => {
    try {
      if (req.params.userId === req.user._id) throw authError(400, 'invalid_friend', 'That friend cannot be removed.');
      await store.removeFriend(req.user._id, String(req.params.userId));
      io?.to('account:' + req.user._id).emit('social:changed');
      io?.to('account:' + String(req.params.userId)).emit('social:changed');
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  return { router, middleware, authenticateAccessToken, issueAccess, safeUser };
}

function safeAvatar(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || value.length > 2048) return null;
  return value;
}

async function hashPassword(password) { return argon2.hash(password, HASH_OPTIONS); }
async function verifyPassword(passwordHash, password) { return argon2.verify(passwordHash, password); }

function errorHandler(error, _req, res, _next) {
  const status = Number(error.status) || (error.code === '23505' ? 409 : 500);
  if (status >= 500) console.error('[accounts] request failed:', error.code || error.name || 'internal_error');
  res.status(status).json({ error: { code: error.code || 'internal_error', message: status >= 500 ? 'The request could not be completed.' : error.message } });
}

module.exports = { createAccountService, errorHandler, safeUser, hashPassword, verifyPassword, ACCESS_TTL_SECONDS, HASH_OPTIONS, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };
