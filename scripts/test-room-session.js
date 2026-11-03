'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'assets', 'tempchat-app.js'), 'utf8');
const noop = () => {};

function makeToken(expSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'user-1', exp: expSeconds })}.signature`;
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function loadApp(fetchImpl, options = {}) {
  const createElement = () => ({
    classList: { add: noop, remove: noop, toggle: noop },
    style: { setProperty: noop },
    dataset: {},
    addEventListener: noop,
    appendChild: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: noop,
    removeAttribute: noop,
    remove: noop,
    focus: noop,
    value: '',
    textContent: '',
    innerHTML: '',
    children: [],
    firstElementChild: null
  });
  const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener: noop,
    getElementById: () => null,
    createElement,
    querySelectorAll: () => [],
    body: { classList },
    documentElement: { style: { setProperty: noop } }
  };
  const window = {
    location: { protocol: 'https:', origin: 'https://app.test', search: '', href: 'https://app.test/' },
    TEMPCHAT_CONFIG: { apiUrl: 'https://api.test', socketUrl: 'https://api.test' },
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    setTimeout,
    clearTimeout
  };
  if (options.nativeStorage) {
    window.TempChatNative = { native: true, SecureStorage: options.nativeStorage };
  }
  window.window = window;
  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const context = {
    window,
    document,
    fetch: fetchImpl,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    AbortController,
    atob,
    btoa,
    localStorage: storage,
    sessionStorage: storage
  };
  vm.createContext(context);
  vm.runInContext(APP_SOURCE, context, { filename: 'tempchat-app.js' });
  return window;
}

async function testGuestFallback() {
  let calls = 0;
  const window = loadApp(async () => {
    calls++;
    return jsonResponse(401, { error: { code: 'refresh_required' } });
  });
  const socket = { auth: { accessToken: 'stale' }, connected: false };
  const result = await window.TempChatApp.prepareRoomReconnect(socket);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.guest, true);
  assert.deepEqual(Object.keys(socket.auth), []);
  assert.equal(calls, 1);
}

async function testFreshTokenAndSingleFlight() {
  let calls = 0;
  let releaseRefresh;
  let mode = 'fresh';
  const now = Math.floor(Date.now() / 1000);
  const freshToken = makeToken(now + 600);
  const window = loadApp(async () => {
    calls++;
    if (mode === 'slow') {
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return jsonResponse(200, { accessToken: freshToken, expiresIn: 600, user: { id: 'user-1' } });
    }
    return jsonResponse(200, { accessToken: freshToken, expiresIn: 600, user: { id: 'user-1' } });
  });
  const socket = { auth: {}, connected: false };

  const first = await window.TempChatApp.prepareRoomReconnect(socket);
  assert.equal(first.ok, true);
  assert.equal(first.refreshed, true);
  assert.equal(socket.auth.accessToken, freshToken);
  assert.equal(calls, 1);

  const second = await window.TempChatApp.prepareRoomReconnect(socket);
  assert.equal(second.ok, true);
  assert.equal(second.refreshed, false);
  assert.equal(calls, 1, 'a fresh access token must not trigger another refresh');

  mode = 'slow';
  const forcedFirst = window.TempChatApp.prepareRoomReconnect(socket, { forceRefresh: true });
  const forcedSecond = window.TempChatApp.prepareRoomReconnect(socket, { forceRefresh: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2, 'concurrent room refreshes must share one request');
  releaseRefresh();
  const forcedResults = await Promise.all([forcedFirst, forcedSecond]);
  assert.equal(forcedResults[0].ok, true);
  assert.equal(forcedResults[1].ok, true);
  assert.equal(calls, 2);
}

async function testExpiredTokenRefreshes() {
  let calls = 0;
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = makeToken(now - 10);
  const freshToken = makeToken(now + 600);
  const window = loadApp(async () => {
    calls++;
    return calls === 1
      ? jsonResponse(200, { accessToken: expiredToken, expiresIn: -1, user: { id: 'user-1' } })
      : jsonResponse(200, { accessToken: freshToken, expiresIn: 600, user: { id: 'user-1' } });
  });
  const socket = { auth: {}, connected: false };

  const first = await window.TempChatApp.prepareRoomReconnect(socket);
  assert.equal(first.refreshed, true);
  assert.equal(socket.auth.accessToken, expiredToken);

  const second = await window.TempChatApp.prepareRoomReconnect(socket);
  assert.equal(second.refreshed, true);
  assert.equal(socket.auth.accessToken, freshToken);
  assert.equal(calls, 2, 'an expired access token must be refreshed before reconnecting');
}

async function testRefreshFailures() {
  let calls = 0;
  let mode = 'fresh';
  const now = Math.floor(Date.now() / 1000);
  const freshToken = makeToken(now + 600);
  const window = loadApp(async () => {
    calls++;
    if (mode === 'expired') return jsonResponse(401, { error: { code: 'refresh_expired' } });
    if (mode === 'rate') return jsonResponse(429, { error: { code: 'rate_limited' } });
    if (mode === 'network') throw new Error('offline');
    return jsonResponse(200, { accessToken: freshToken, expiresIn: 600, user: { id: 'user-1' } });
  });
  const socket = { auth: {}, connected: false };
  assert.equal((await window.TempChatApp.prepareRoomReconnect(socket)).ok, true);

  mode = 'expired';
  const expired = await window.TempChatApp.prepareRoomReconnect(socket, { forceRefresh: true });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');

  mode = 'network';
  const offline = await window.TempChatApp.prepareRoomReconnect(socket, { forceRefresh: true });
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, 'network');

  mode = 'rate';
  const rateLimited = await window.TempChatApp.prepareRoomReconnect(socket, { forceRefresh: true });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.reason, 'network');
  assert.equal(calls, 4);
}

function makeSecureStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { get: [], set: [], remove: [] };
  return {
    data,
    calls,
    async getItem(key) { calls.get.push(key); return data.has(key) ? data.get(key) : null; },
    async setItem(key, value) { calls.set.push([key, value]); data.set(key, value); },
    async removeItem(key) { calls.remove.push(key); data.delete(key); }
  };
}

async function testNativeRotationPersistsRawToken() {
  const key = 'tempchat.refresh.v1';
  const storage = makeSecureStorage({ [key]: 'refresh-old' });
  const now = Math.floor(Date.now() / 1000);
  const window = loadApp(async (url) => {
    if (String(url).includes('/api/auth/refresh')) {
      return jsonResponse(200, {
        accessToken: makeToken(now + 600),
        expiresIn: 600,
        refreshToken: 'refresh-new',
        user: { id: 'user-1', username: 'tester' }
      });
    }
    return jsonResponse(200, { friends: [], requests: [] });
  }, { nativeStorage: storage });

  await window.TempChatApp.retryRestore();
  assert.equal(window.TempChatApp.signedIn, true);
  assert.equal(storage.data.get(key), 'refresh-new', 'rotated refresh token must be written with setItem');
  assert.deepEqual(storage.calls.set, [[key, 'refresh-new']]);
  assert.equal(storage.calls.remove.length, 0);
}

async function testNativeRestoreRetainsTokenOnNetworkFailure() {
  const key = 'tempchat.refresh.v1';
  const storage = makeSecureStorage({ [key]: 'refresh-old' });
  let calls = 0;
  const window = loadApp(async () => {
    calls++;
    throw new Error('offline');
  }, { nativeStorage: storage });

  await window.TempChatApp.retryRestore();
  assert.equal(calls, 1);
  assert.equal(window.TempChatApp.signedIn, false);
  assert.equal(window.TempChatApp.restorePending, true);
  assert.equal(storage.data.get(key), 'refresh-old', 'network failures must not delete the stored token');
  assert.equal(storage.calls.remove.length, 0);
}

async function testNativeRestoreClearsTokenOnlyWhenExpired() {
  const key = 'tempchat.refresh.v1';
  const storage = makeSecureStorage({ [key]: 'refresh-old' });
  const window = loadApp(async () => jsonResponse(401, { error: { code: 'refresh_expired' } }), { nativeStorage: storage });

  await window.TempChatApp.retryRestore();
  assert.equal(window.TempChatApp.restorePending, false);
  assert.equal(storage.data.has(key), false, 'a definitive 401 must clear the stored token');
  assert.deepEqual(storage.calls.remove, [key]);
}

(async () => {
  await testGuestFallback();
  await testFreshTokenAndSingleFlight();
  await testExpiredTokenRefreshes();
  await testRefreshFailures();
  await testNativeRotationPersistsRawToken();
  await testNativeRestoreRetainsTokenOnNetworkFailure();
  await testNativeRestoreClearsTokenOnlyWhenExpired();
  console.log('Room session tests passed: guest fallback, fresh-token reuse, expiry refresh, single-flight rotation, classified failures, native raw-token persistence, and restore-gate retention/expiry.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
