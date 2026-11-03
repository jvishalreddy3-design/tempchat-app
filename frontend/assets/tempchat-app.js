/* TempChat account-first client.
 *
 * Realtime transport: the existing authenticated Socket.IO service on Render.
 * Private message text is kept only in this tab's JavaScript memory while a
 * conversation is open. It is never written to localStorage, sessionStorage,
 * IndexedDB, cookies, or the database.
 */
(function () {
  'use strict';

  const CONFIG = window.TEMPCHAT_CONFIG || {};
  const FALLBACK_ORIGIN = /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : 'https://tempchat-app-backend.onrender.com';
  const API_BASE = String(CONFIG.apiUrl || CONFIG.publicBaseUrl || FALLBACK_ORIGIN).replace(/\/+$/, '');
  const SOCKET_URL = String(CONFIG.socketUrl || CONFIG.apiUrl || FALLBACK_ORIGIN).replace(/\/+$/, '');
  const REFRESH_KEY = 'tempchat.refresh.v1';
  const REFRESH_TIMEOUT_MS = 12000;
  const isNative = Boolean(window.TempChatNative?.native) || Boolean(window.Capacitor?.isNativePlatform?.()) || Boolean(window.TempChatNative?.SecureStorage);

  const state = {
    accessToken: null,
    accessTokenExpiresAt: 0,
    refreshToken: null,
    user: null,
    friends: [],
    requests: [],
    presence: new Map(),
    socket: null,
    socketRefreshTried: false,
    activeChat: null,
    chatInbox: new Map(),
    chatOpenSeq: 0,
    viewedProfile: null,
    friendsFilter: 'all',
    requestsFilter: 'incoming',
    searchResults: [],
    searchTimer: null,
    typingTimer: null,
    typingEmitAt: 0,
    booted: false,
    currentScreen: null,
    screenHistory: [],
    lastExitPromptAt: 0,
    presenceNotifiedAt: new Map(),
    notifiedRequests: new Set(),
    notificationKeys: new Set(),
    socialLoaded: false,
    restoring: false,
    restorePending: false
  };

  let accountApp = null;
  let backButton = null;
  let refreshPromise = null;
  let lastRefreshFailure = null;
  let storageWarningShown = false;

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function byId(id) { return document.getElementById(id); }
  function setText(id, value) { const el = byId(id); if (el) el.textContent = String(value ?? ''); }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return (parts.map((part) => part[0]).join('') || '?').toUpperCase();
  }
  function formatLastSeen(value) {
    if (!value) return 'recently';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    const diff = Date.now() - date.getTime();
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))}h ago`;
    return date.toLocaleDateString();
  }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function avatarInner(user) {
    const url = String(user?.avatarUrl || '');
    if (/^https:\/\//i.test(url)) return `<img src="${esc(url)}" alt="">`;
    return esc(initials(user?.displayName || user?.username));
  }
  function avatarHtml(user, sizeClass = '') {
    const online = user?.online ? 'online' : '';
    return `<span class="tc-avatar ${sizeClass}">${avatarInner(user)}<span class="tc-dot ${online}"></span></span>`;
  }
  function displayNameOf(user) {
    return String(user?.displayName || user?.username || 'EKA user');
  }
  function setVisible(id, visible) {
    const el = byId(id);
    if (el) el.classList.toggle('hidden', !visible);
  }
  function setError(id, message) {
    const el = byId(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('show', Boolean(message));
  }
  function setNotice(id, message) {
    const el = byId(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('show', Boolean(message));
  }
  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${esc(busyText || 'Working…')}`;
    } else {
      button.disabled = false;
      if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
    }
  }
  function toast(message, type = 'info') {
    const container = byId('toast-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = `tc-toast ${type}`;
    const icon = document.createElement('i');
    icon.className = type === 'success' ? 'fa-solid fa-circle-check' : type === 'error' ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-info';
    const text = document.createElement('span');
    text.textContent = String(message ?? '');
    item.append(icon, text);
    container.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(-8px)';
      setTimeout(() => item.remove(), 250);
    }, 3200);
  }

  // ---------------------------------------------------------------------------
  // EKA notifications (presence + friend requests)
  // ---------------------------------------------------------------------------

  const EKA_NOTIFY_MAX = 3;
  const EKA_PRESENCE_COOLDOWN_MS = 10 * 60 * 1000;

  function incomingRequests() {
    return state.requests.filter((request) => request.direction === 'incoming');
  }

  function updateRequestIndicators() {
    const count = incomingRequests().length;
    for (const id of ['tc-nav-requests-badge', 'eka-bell-badge']) {
      const badge = byId(id);
      if (!badge) continue;
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.toggle('hidden', count === 0);
    }
  }

  function removeEkaNotification(item) {
    if (!item || item.dataset.closing === 'true') return;
    item.dataset.closing = 'true';
    state.notificationKeys.delete(item.dataset.notifyKey || '');
    item.classList.add('eka-notify-out');
    setTimeout(() => item.remove(), 280);
  }

  function dismissEkaNotification(key) {
    const stack = byId('eka-notify-stack');
    if (!stack) return;
    for (const item of stack.querySelectorAll('[data-notify-key]')) {
      if (!key || item.dataset.notifyKey === key) removeEkaNotification(item);
    }
  }

  function clearNotifications() {
    const stack = byId('eka-notify-stack');
    if (stack) stack.innerHTML = '';
    state.notificationKeys.clear();
    state.presenceNotifiedAt.clear();
    state.notifiedRequests.clear();
  }

  function showEkaNotification(options = {}) {
    const stack = byId('eka-notify-stack');
    if (!stack || !options.key) return null;
    if (state.notificationKeys.has(options.key)) {
      return stack.querySelector(`[data-notify-key="${options.key}"]`);
    }
    state.notificationKeys.add(options.key);

    while (stack.children.length >= EKA_NOTIFY_MAX) {
      const oldest = stack.firstElementChild;
      if (!oldest) break;
      state.notificationKeys.delete(oldest.dataset.notifyKey || '');
      oldest.remove();
    }

    const item = document.createElement('div');
    item.className = `eka-notify ${options.variant || ''}`.trim();
    item.dataset.notifyKey = options.key;
    item.setAttribute('role', 'status');

    const avatar = document.createElement('span');
    avatar.className = 'eka-notify-avatar';
    avatar.innerHTML = options.user ? avatarInner(options.user) : '<i class="fa-solid fa-bell"></i>';
    if (options.user?.id) {
      avatar.dataset.notifyProfile = options.user.id;
      avatar.setAttribute('role', 'button');
      avatar.setAttribute('tabindex', '0');
      avatar.setAttribute('aria-label', `Open ${displayNameOf(options.user)} profile`);
    }

    const body = document.createElement('div');
    body.className = 'eka-notify-body';
    const title = document.createElement('strong');
    title.textContent = String(options.title || 'EKA');
    const copy = document.createElement('p');
    copy.textContent = String(options.body || '');
    body.append(title, copy);

    item.append(avatar, body);

    if (options.actionsHtml) {
      const actions = document.createElement('div');
      actions.className = 'eka-notify-actions';
      actions.innerHTML = options.actionsHtml;
      item.appendChild(actions);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'eka-notify-close';
    close.dataset.notifyClose = 'true';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    item.appendChild(close);

    stack.appendChild(item);
    if (options.timeout !== 0) {
      setTimeout(() => removeEkaNotification(item), Number(options.timeout) || 6000);
    }
    return item;
  }

  function notifyFriendOnline(friend) {
    if (!friend?.id) return;
    const now = Date.now();
    const last = state.presenceNotifiedAt.get(friend.id) || 0;
    if (now - last < EKA_PRESENCE_COOLDOWN_MS) return;
    state.presenceNotifiedAt.set(friend.id, now);
    showEkaNotification({
      key: `presence:${friend.id}:${now}`,
      variant: 'eka-notify-online',
      user: friend,
      title: displayNameOf(friend),
      body: `@${friend.username || 'friend'} is online now`,
      timeout: 5200
    });
  }

  function notifyPrivateMessage(message) {
    if (!message?.id || !message?.from) return;
    const friend = state.friends.find((entry) => entry.id === message.from)
      || { id: message.from, username: message.sender || 'friend', displayName: message.sender || 'Friend' };
    const preview = String(message.text || '');
    showEkaNotification({
      key: `message:${message.conversationId}:${message.id}`,
      user: friend,
      title: displayNameOf(friend),
      body: preview.length > 90 ? `${preview.slice(0, 90)}…` : preview,
      actionsHtml: `<button type="button" class="eka-notify-accept" data-notify-chat="${esc(friend.id)}">Open chat</button>`,
      timeout: 9000
    });
  }

  function notifyFriendRequest(request) {
    if (!request?.id || state.notifiedRequests.has(request.id)) return;
    state.notifiedRequests.add(request.id);
    const user = request.user || {};
    showEkaNotification({
      key: `request:${request.id}`,
      variant: 'eka-notify-request',
      user,
      title: displayNameOf(user),
      body: `@${user.username || 'someone'} is trying to send you a friend request.`,
      actionsHtml: `<button type="button" class="eka-notify-accept" data-notify-accept="${esc(request.id)}">Accept</button><button type="button" data-notify-decline="${esc(request.id)}">Reject</button>`,
      timeout: 12000
    });
  }

  async function handleEkaNotificationClick(event) {
    const stack = byId('eka-notify-stack');
    if (!stack || !stack.contains(event.target)) return;

    const close = event.target.closest('[data-notify-close]');
    if (close) {
      event.preventDefault();
      removeEkaNotification(close.closest('.eka-notify'));
      return;
    }

    const accept = event.target.closest('[data-notify-accept]');
    if (accept) {
      event.preventDefault();
      const id = accept.getAttribute('data-notify-accept');
      dismissEkaNotification(`request:${id}`);
      await respondRequest(id, true);
      return;
    }

    const decline = event.target.closest('[data-notify-decline]');
    if (decline) {
      event.preventDefault();
      const id = decline.getAttribute('data-notify-decline');
      dismissEkaNotification(`request:${id}`);
      await respondRequest(id, false);
      return;
    }

    const chatAction = event.target.closest('[data-notify-chat]');
    if (chatAction) {
      event.preventDefault();
      const friendId = chatAction.getAttribute('data-notify-chat');
      removeEkaNotification(chatAction.closest('.eka-notify'));
      openChat(friendId);
      return;
    }

    const profile = event.target.closest('[data-notify-profile]');
    if (profile) {
      event.preventDefault();
      dismissEkaNotification();
      openProfile(profile.getAttribute('data-notify-profile'));
    }
  }

  // ---------------------------------------------------------------------------
  // Secure session persistence
  // ---------------------------------------------------------------------------

  async function secureGet(key) {
    const storage = window.TempChatNative?.SecureStorage;
    if (!storage) return null;
    try {
      const value = typeof storage.getItem === 'function'
        ? await storage.getItem(key)
        : await storage.get(key);
      return typeof value === 'string' && value ? value : null;
    } catch (_) { return null; }
  }
  async function secureSet(key, value) {
    const storage = window.TempChatNative?.SecureStorage;
    if (!storage) return false;
    const raw = String(value);
    try {
      if (typeof storage.setItem === 'function') await storage.setItem(key, raw);
      else await storage.set(key, raw);
      // Read the value back so a failed native write cannot silently look
      // like a successful sign-in that will not survive the next launch.
      const stored = typeof storage.getItem === 'function'
        ? await storage.getItem(key)
        : await storage.get(key);
      return stored === raw;
    } catch (_) { return false; }
  }
  async function secureRemove(key) {
    const storage = window.TempChatNative?.SecureStorage;
    if (!storage) return;
    try {
      if (typeof storage.removeItem === 'function') await storage.removeItem(key);
      else await storage.remove(key);
    } catch (_) { /* native storage unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  function apiUrl(path) { return `${API_BASE}${path}`; }

  async function apiFetch(path, options = {}) {
    const { method = 'GET', body, auth = true, retry = true } = options;
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (isNative) headers['X-TempChat-Client'] = 'native';
    if (auth && state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

    let response;
    try {
      response = await fetch(apiUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include'
      });
    } catch (_) {
      const error = new Error('Cannot reach the EKA server. Check your connection.');
      error.code = 'network';
      throw error;
    }

    if (response.status === 401 && auth && retry) {
      if (await refreshSession()) {
        return apiFetch(path, { method, body, auth, retry: false });
      }
      // A 401 caused by a dropped connection is not an expired session. Do not
      // let the caller clear a refresh token that may still be perfectly valid.
      if (refreshFailureReason() === 'network') {
        const error = new Error('Cannot reach the EKA server. Check your connection.');
        error.code = 'network';
        throw error;
      }
    }

    let data = null;
    try { data = await response.json(); } catch (_) { /* empty response */ }
    if (!response.ok) {
      const error = new Error(data?.error?.message || 'The request could not be completed.');
      error.code = data?.error?.code || 'request_failed';
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function accessTokenExpiry(token) {
    try {
      const payload = String(token || '').split('.')[1];
      if (!payload) return 0;
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      const claims = JSON.parse(atob(padded));
      return Number(claims?.exp || 0) * 1000;
    } catch (_) { return 0; }
  }

  function rememberAccessToken(token, expiresIn) {
    state.accessToken = token;
    const seconds = Number(expiresIn);
    state.accessTokenExpiresAt = Number.isFinite(seconds) && seconds > 0
      ? Date.now() + seconds * 1000
      : accessTokenExpiry(token);
  }

  function accessTokenIsFresh(marginMs = 30 * 1000) {
    if (!state.accessToken) return false;
    if (!state.accessTokenExpiresAt) return true;
    return state.accessTokenExpiresAt - Date.now() > marginMs;
  }

  function refreshFailureReason() {
    if (!lastRefreshFailure) return 'network';
    if (lastRefreshFailure.code === 'network') return 'network';
    if (!lastRefreshFailure.status) return 'network';
    if (lastRefreshFailure.status === 408 || lastRefreshFailure.status === 429 || lastRefreshFailure.status >= 500) return 'network';
    return 'expired';
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    const request = (async () => {
      lastRefreshFailure = null;
      if (isNative && !state.refreshToken) {
        lastRefreshFailure = { status: 401, code: 'refresh_required' };
        return false;
      }
      const headers = {};
      let body;
      if (isNative) {
        headers['Content-Type'] = 'application/json';
        headers['X-TempChat-Client'] = 'native';
        body = JSON.stringify({ refreshToken: state.refreshToken });
      }
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS) : null;
        let response;
        try {
          response = await fetch(apiUrl('/api/auth/refresh'), {
            method: 'POST',
            headers,
            body,
            credentials: 'include',
            signal: controller?.signal
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
        let data = null;
        try { data = await response.json(); } catch (_) { /* empty response */ }
        if (!response.ok || !data?.accessToken) {
          lastRefreshFailure = { status: response.status, code: data?.error?.code || 'refresh_failed' };
          return false;
        }
        rememberAccessToken(data.accessToken, data.expiresIn);
        if (data.user) state.user = data.user;
        if (data.refreshToken) {
          await persistRefreshToken(data.refreshToken);
        }
        window.TempChatRoom?.authenticate?.(state.accessToken);
        if (state.socket?.connected && state.socket.auth?.accessToken !== state.accessToken) {
          state.socket.auth = { accessToken: state.accessToken };
          state.socket.disconnect().connect();
        }
        return true;
      } catch (_) {
        lastRefreshFailure = { status: 0, code: 'network' };
        return false;
      }
    })();
    refreshPromise = request;
    try { return await request; } finally { if (refreshPromise === request) refreshPromise = null; }
  }

  async function persistRefreshToken(token) {
    state.refreshToken = token;
    const saved = await secureSet(REFRESH_KEY, token);
    if (!saved && isNative && !storageWarningShown) {
      storageWarningShown = true;
      toast('This device could not save your session. You may need to sign in again after closing the app.', 'error');
    }
    return saved;
  }

  async function applySession(data) {
    rememberAccessToken(data.accessToken, data.expiresIn);
    if (data.user) state.user = data.user;
    if (data.refreshToken) {
      await persistRefreshToken(data.refreshToken);
    }
    window.TempChatRoom?.authenticate?.(state.accessToken);
  }

  async function clearSession() {
    state.accessToken = null;
    state.accessTokenExpiresAt = 0;
    state.refreshToken = null;
    state.user = null;
    state.friends = [];
    state.requests = [];
    state.presence.clear();
    state.activeChat = null;
    state.viewedProfile = null;
    state.searchResults = [];
    state.socialLoaded = false;
    lastRefreshFailure = null;
    await secureRemove(REFRESH_KEY);
    if (state.socket) {
      state.socket.removeAllListeners();
      state.socket.disconnect();
      state.socket = null;
    }
    clearChatMemory();
    clearChatInbox();
    clearNotifications();
  }

  // ---------------------------------------------------------------------------
  // Screens and navigation
  // ---------------------------------------------------------------------------

  const SCREENS = {
    restore: 'screen-restore',
    welcome: 'screen-welcome',
    login: 'screen-login',
    register: 'screen-register',
    home: 'screen-home',
    friends: 'screen-friends',
    add: 'screen-add',
    requests: 'screen-requests',
    chat: 'screen-chat',
    profile: 'screen-profile',
    settings: 'screen-settings'
  };
  const NAV_SCREENS = new Set(['home', 'friends', 'requests', 'settings']);

  function showScreen(name, options = {}) {
    const { fromBack = false, reset = false } = options;
    const targetId = SCREENS[name] || SCREENS.welcome;
    if (reset || name === 'home') {
      state.screenHistory = [name];
    } else if (fromBack) {
      const previousIndex = state.screenHistory.lastIndexOf(name);
      state.screenHistory = previousIndex >= 0 ? state.screenHistory.slice(0, previousIndex + 1) : [name];
    } else if (state.currentScreen !== name) {
      state.screenHistory.push(name);
    }
    state.currentScreen = name;
    for (const id of Object.values(SCREENS)) {
      const element = byId(id);
      if (element) element.classList.toggle('hidden', id !== targetId);
    }
    const target = byId(targetId);
    target?.querySelector('.tc-scroll')?.scrollTo({ top: 0 });
    const nav = byId('tc-bottom-nav');
    nav?.classList.toggle('hidden', !NAV_SCREENS.has(name));
    for (const item of document.querySelectorAll('[data-nav]')) {
      item.classList.toggle('active', item.getAttribute('data-nav') === name);
    }
    if (name === 'home') renderHome();
    if (name === 'friends') renderFriends();
    if (name === 'requests') renderRequests();
    if (name === 'settings') renderSettings();
    if (name === 'profile') renderProfile();
    if (name === 'chat') renderChatHeader();
    if (name === 'add') { renderSearchResults(); byId('tc-search-input')?.focus(); }
    if (name === 'login') byId('tc-login-username')?.focus();
  }

  function setAccountMode(on) {
    document.body.classList.toggle('account-mode', on);
    accountApp?.classList.toggle('hidden', !on);
    if (on) {
      backButton?.classList.add('hidden');
    } else if (backButton) {
      backButton.classList.remove('hidden');
      backButton.innerHTML = state.user
        ? '<i class="fa-solid fa-user"></i> My account'
        : '<i class="fa-solid fa-right-to-bracket"></i> Sign in';
    }
  }

  function openRooms() {
    setAccountMode(false);
    try { window.TempChatRoom?.open?.(); } catch (_) { window.showLandingView?.(); }
  }

  function backToAccount() {
    if (!state.user) {
      setAccountMode(true);
      showScreen('welcome');
      return;
    }
    setAccountMode(true);
    showScreen('home', { reset: true });
  }

  function previousScreen() {
    if (state.screenHistory.length > 1) {
      state.screenHistory.pop();
      return state.screenHistory[state.screenHistory.length - 1];
    }
    const parents = { login: 'welcome', register: 'welcome', friends: 'home', add: 'friends', requests: 'home', chat: 'friends', profile: 'home', settings: 'home' };
    return parents[state.currentScreen] || null;
  }

  function requestNativeExit() {
    const now = Date.now();
    if (now - state.lastExitPromptAt > 2000) {
      state.lastExitPromptAt = now;
      toast('Press back again to exit.');
      return true;
    }
    window.TempChatNative?.App?.exitApp?.();
    return true;
  }

  function handleNativeBack() {
    if (!document.body.classList.contains('account-mode')) {
      backToAccount();
      return true;
    }
    if (state.currentScreen === 'chat') {
      leaveChat();
      return true;
    }
    const previous = previousScreen();
    if (previous) {
      showScreen(previous, { fromBack: true });
      return true;
    }
    return requestNativeExit();
  }

  // ---------------------------------------------------------------------------
  // Social data
  // ---------------------------------------------------------------------------

  function normalizeFriend(user) {
    const id = String(user.id || user._id || '');
    const presence = state.presence.get(id);
    return {
      id,
      username: user.username || '',
      displayName: user.displayName || user.username || 'EKA user',
      avatarUrl: user.avatarUrl || null,
      online: presence ? presence.online : Boolean(user.online),
      lastSeenAt: presence?.lastSeenAt || user.lastSeenAt || null
    };
  }

  async function loadSocial() {
    const [friendsData, requestsData] = await Promise.all([
      apiFetch('/api/auth/friends'),
      apiFetch('/api/auth/friend-requests')
    ]);
    const previousIds = new Set(incomingRequests().map((request) => request.id));
    state.friends = (friendsData.friends || []).map(normalizeFriend);
    state.requests = requestsData.requests || [];
    if (state.socialLoaded) {
      for (const request of incomingRequests()) {
        if (request.id && !previousIds.has(request.id)) notifyFriendRequest(request);
      }
    }
    state.socialLoaded = true;
    renderAll();
  }

  function renderAll() {
    renderHome();
    renderFriends();
    renderRequests();
    renderSearchResults();
    renderSettings();
    updateRequestIndicators();
    if (state.viewedProfile) renderProfile();
    renderChatHeader();
  }

  function friendRowHtml(friend) {
    const status = friend.online ? 'Online' : friend.lastSeenAt ? `Last seen ${formatLastSeen(friend.lastSeenAt)}` : 'Offline';
    return `<div class="tc-row">
      <button type="button" class="tc-avatar" data-profile-user="${esc(friend.id)}" aria-label="Open ${esc(displayNameOf(friend))} profile">${avatarInner(friend)}<span class="tc-dot ${friend.online ? 'online' : ''}"></span></button>
      <div class="tc-row-main" data-profile-user="${esc(friend.id)}" role="button" tabindex="0">
        <div class="tc-row-name">${esc(displayNameOf(friend))}</div>
        <div class="tc-row-sub">@${esc(friend.username)} · ${esc(status)}</div>
      </div>
      <div class="tc-row-actions">
        <button type="button" class="tc-btn tc-btn-primary tc-btn-sm" data-chat-user="${esc(friend.id)}"><i class="fa-solid fa-comment"></i> Chat</button>
      </div>
    </div>`;
  }

  function emptyHtml(icon, title, text) {
    return `<div class="tc-empty"><i class="fa-solid ${esc(icon)}"></i><strong>${esc(title)}</strong><div>${esc(text)}</div></div>`;
  }

  function renderHome() {
    const online = state.friends.filter((friend) => friend.online);
    const offline = state.friends.filter((friend) => !friend.online);
    const incoming = state.requests.filter((request) => request.direction === 'incoming');
    setText('tc-home-name', displayNameOf(state.user));
    setText('tc-online-count', online.length);
    setText('tc-home-friends-count', `${state.friends.length} friend${state.friends.length === 1 ? '' : 's'}`);
    setText('tc-home-requests-count', `${incoming.length} pending`);
    setVisible('tc-home-requests-badge', incoming.length > 0);
    setText('tc-home-requests-badge', incoming.length > 9 ? '9+' : incoming.length);

    const onlineList = byId('tc-home-online');
    if (onlineList) {
      onlineList.innerHTML = online.length
        ? online.map(friendRowHtml).join('')
        : emptyHtml('fa-user-clock', 'No friends online', 'When a friend connects, they will appear here with a green dot.');
    }
    const offlineList = byId('tc-home-offline');
    if (offlineList) {
      offlineList.innerHTML = offline.length
        ? offline.map(friendRowHtml).join('')
        : emptyHtml('fa-user-group', state.friends.length ? 'Everyone is online' : 'No friends yet', state.friends.length ? 'Your offline friends will appear here.' : 'Add a friend by username to start a temporary private chat.');
    }
  }

  function renderFriends() {
    const filter = state.friendsFilter;
    const list = state.friends.filter((friend) => filter === 'all' || (filter === 'online' ? friend.online : !friend.online));
    setText('tc-friends-count', `${state.friends.length} friend${state.friends.length === 1 ? '' : 's'}`);
    for (const tab of document.querySelectorAll('[data-friends-filter]')) {
      tab.classList.toggle('active', tab.getAttribute('data-friends-filter') === filter);
    }
    const container = byId('tc-friends-list');
    if (!container) return;
    container.innerHTML = list.length
      ? list.map(friendRowHtml).join('')
      : emptyHtml('fa-user-plus', filter === 'all' ? 'No friends yet' : `No ${filter} friends`, filter === 'all' ? 'Search by username and send a friend request.' : 'Try another tab or add a new friend.');
  }

  function renderRequests() {
    const incoming = state.requests.filter((request) => request.direction === 'incoming');
    const outgoing = state.requests.filter((request) => request.direction === 'outgoing');
    setText('tc-requests-incoming-count', incoming.length);
    setText('tc-requests-outgoing-count', outgoing.length);
    for (const tab of document.querySelectorAll('[data-requests-filter]')) {
      tab.classList.toggle('active', tab.getAttribute('data-requests-filter') === state.requestsFilter);
    }
    const list = state.requestsFilter === 'incoming' ? incoming : outgoing;
    const container = byId('tc-requests-list');
    if (!container) return;
    if (!list.length) {
      container.innerHTML = emptyHtml('fa-envelope-open', state.requestsFilter === 'incoming' ? 'No incoming requests' : 'No sent requests', state.requestsFilter === 'incoming' ? 'Friend requests sent to you will appear here.' : 'Requests you send will appear here until they are answered.');
      return;
    }
    container.innerHTML = list.map((request) => {
      const user = request.user || {};
      const actions = request.direction === 'incoming'
        ? `<button type="button" class="tc-btn tc-btn-primary tc-btn-sm" data-accept-request="${esc(request.id)}">Accept</button>
           <button type="button" class="tc-btn tc-btn-ghost tc-btn-sm" data-decline-request="${esc(request.id)}">Decline</button>`
        : `<button type="button" class="tc-btn tc-btn-ghost tc-btn-sm" data-cancel-request="${esc(request.id)}">Cancel</button>`;
      return `<div class="tc-row">
        <button type="button" class="tc-avatar" data-profile-user="${esc(user.id)}" aria-label="Open profile">${avatarInner(user)}</button>
        <div class="tc-row-main">
          <div class="tc-row-name">${esc(displayNameOf(user))}</div>
          <div class="tc-row-sub">@${esc(user.username || 'unknown')} · ${esc(formatDate(request.createdAt))}</div>
        </div>
        <div class="tc-row-actions">${actions}</div>
      </div>`;
    }).join('');
  }

  function requestStateFor(userId) {
    if (state.friends.some((friend) => friend.id === userId)) return 'friends';
    const outgoing = state.requests.find((request) => request.direction === 'outgoing' && request.user?.id === userId);
    if (outgoing) return 'outgoing';
    const incoming = state.requests.find((request) => request.direction === 'incoming' && request.user?.id === userId);
    if (incoming) return 'incoming';
    return 'none';
  }

  function renderSearchResults(message) {
    const container = byId('tc-search-results');
    if (!container) return;
    const status = byId('tc-search-status');
    if (status) status.textContent = message || (state.searchResults.length ? `${state.searchResults.length} result${state.searchResults.length === 1 ? '' : 's'}` : '');
    if (!state.searchResults.length) {
      container.innerHTML = emptyHtml('fa-magnifying-glass', 'Find friends', 'Search for an exact username or part of a username. Usernames are 3–24 characters.');
      return;
    }
    container.innerHTML = state.searchResults.map((user) => {
      const relationship = requestStateFor(user.id);
      let action;
      if (relationship === 'friends') action = '<span class="tc-chip"><i class="fa-solid fa-check"></i> Friends</span>';
      else if (relationship === 'outgoing') action = '<span class="tc-chip">Requested</span>';
      else if (relationship === 'incoming') action = `<button type="button" class="tc-btn tc-btn-soft tc-btn-sm" data-nav="requests">Respond</button>`;
      else action = `<button type="button" class="tc-btn tc-btn-primary tc-btn-sm" data-send-request="${esc(user.username)}"><i class="fa-solid fa-user-plus"></i> Add</button>`;
      return `<div class="tc-row">
        <button type="button" class="tc-avatar" data-profile-user="${esc(user.id)}" aria-label="Open profile">${avatarInner(user)}</button>
        <div class="tc-row-main">
          <div class="tc-row-name">${esc(displayNameOf(user))}</div>
          <div class="tc-row-sub">@${esc(user.username)}</div>
        </div>
        <div class="tc-row-actions">${action}</div>
      </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Realtime
  // ---------------------------------------------------------------------------

  function connectSocket() {
    if (!window.io) {
      toast('Chat client unavailable. Refresh the app.', 'error');
      return;
    }
    if (!SOCKET_URL) {
      toast('Chat endpoint is not configured for this build.', 'error');
      return;
    }
    if (state.socket) {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    }
    state.socketRefreshTried = false;
    const socket = window.io(SOCKET_URL, {
      auth: { accessToken: state.accessToken },
      timeout: 10000,
      reconnection: true,
      reconnectionAttempts: 12
    });
    state.socket = socket;

    socket.on('connect', () => {
      state.socketRefreshTried = false;
      if (state.activeChat) {
        // A reconnect creates a new socket ID on the server, so the previous
        // conversation registration is gone. Re-open the active chat before
        // enabling the composer again.
        if (state.currentScreen === 'chat') restoreActiveChat();
        else renderChatHeader();
      }
    });
    socket.on('disconnect', async (reason) => {
      // Privacy rule: a dropped connection clears the active conversation.
      // Keep the friend on screen so a reconnect can re-open the conversation.
      markChatDisconnected();
      // Socket.IO does not automatically reconnect after a server-initiated
      // disconnect. The backend uses one when the 10-minute JWT expires, so
      // rotate the session and explicitly reconnect with the fresh token.
      if (reason === 'io server disconnect' && state.socket === socket && state.user) {
        if (await refreshSession()) {
          socket.auth = { accessToken: state.accessToken };
          socket.connect();
        } else if (refreshFailureReason() === 'expired') {
          await handleSessionExpired();
        } else {
          toast('Could not refresh your session. Check your connection and try again.', 'error');
        }
      }
    });
    socket.on('connect_error', async (error) => {
      if (!state.socketRefreshTried && /auth|token|session|expired/i.test(error?.message || '')) {
        state.socketRefreshTried = true;
        if (await refreshSession()) {
          socket.auth = { accessToken: state.accessToken };
          socket.connect();
        } else if (refreshFailureReason() === 'expired') {
          await handleSessionExpired();
        }
      }
    });
    socket.on('social:ready', (data) => {
      if (data?.user) state.user = { ...state.user, ...data.user };
      if (Array.isArray(data?.friends)) {
        for (const friend of data.friends) {
          state.presence.set(friend.id, { online: Boolean(friend.online), lastSeenAt: friend.lastSeenAt || null });
        }
        state.friends = data.friends.map(normalizeFriend);
      }
      renderAll();
    });
    socket.on('friends:presence', (payload) => {
      if (!payload?.userId) return;
      const previous = state.presence.get(payload.userId);
      const wasOffline = previous ? previous.online === false : false;
      state.presence.set(payload.userId, { online: Boolean(payload.online), lastSeenAt: payload.lastSeenAt || null });
      const friend = state.friends.find((entry) => entry.id === payload.userId);
      if (friend) {
        friend.online = Boolean(payload.online);
        if (payload.lastSeenAt) friend.lastSeenAt = payload.lastSeenAt;
        if (wasOffline && payload.online) notifyFriendOnline(friend);
      }
      if (state.activeChat?.friend?.id === payload.userId) {
        state.activeChat.peerOnline = Boolean(payload.online);
        state.activeChat.friend.online = Boolean(payload.online);
        if (payload.lastSeenAt) state.activeChat.friend.lastSeenAt = payload.lastSeenAt;
        renderChatHeader();
      }
      renderAll();
    });
    socket.on('friends:request', (payload) => {
      const sender = payload?.sender;
      if (!sender?.id) return;
      const request = {
        id: String(payload.requestId || ''),
        state: 'pending',
        direction: 'incoming',
        createdAt: payload.createdAt || new Date().toISOString(),
        user: sender
      };
      if (request.id && !state.requests.some((entry) => entry.id === request.id)) {
        state.requests = [request, ...state.requests];
      }
      renderAll();
      notifyFriendRequest(request);
    });
    socket.on('social:changed', () => { loadSocial().catch(() => {}); });
    socket.on('private:message', (message, acknowledge) => {
      // Acknowledge only after the message has actually been accepted: either
      // rendered in the matching active conversation or kept in the client's
      // ephemeral inbox. This is what makes "Delivered" truthful.
      const accepted = acceptIncomingMessage(message);
      if (typeof acknowledge === 'function') acknowledge({ received: accepted });
    });
    socket.on('private:typing', (payload) => {
      if (!state.activeChat || payload?.conversationId !== state.activeChat.conversationId) return;
      showTyping(Boolean(payload.isTyping));
    });
  }

  function emitAck(event, payload, timeout = 8000) {
    return new Promise((resolve) => {
      if (!state.socket || !state.socket.connected) {
        resolve({ success: false, message: 'Not connected to the chat server.' });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, message: 'The chat server did not respond.' });
      }, timeout);
      state.socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response || { success: false, message: 'No response.' });
      });
    });
  }

  function waitForSocket(timeout = 6000) {
    return new Promise((resolve) => {
      if (state.socket?.connected) return resolve(true);
      if (!state.socket) return resolve(false);
      let settled = false;
      const onConnect = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.socket?.off('connect', onConnect);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        state.socket?.off('connect', onConnect);
        resolve(false);
      }, timeout);
      state.socket.once('connect', onConnect);
    });
  }

  // ---------------------------------------------------------------------------
  // Private chat (memory only)
  // ---------------------------------------------------------------------------

  function newMessageId() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch (_) { /* fall through */ }
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  const CHAT_INBOX_LIMIT = 100;

  function inboxFor(conversationId) {
    if (!conversationId) return null;
    let list = state.chatInbox.get(conversationId);
    if (!list) {
      list = [];
      state.chatInbox.set(conversationId, list);
    }
    return list;
  }

  function takeChatInbox(conversationId) {
    const list = state.chatInbox.get(conversationId);
    if (!list) return [];
    state.chatInbox.delete(conversationId);
    return [...list];
  }

  function clearChatInbox() {
    state.chatInbox.clear();
  }

  function acceptIncomingMessage(message) {
    if (!state.user
      || typeof message?.id !== 'string'
      || typeof message?.conversationId !== 'string'
      || typeof message?.text !== 'string') return false;

    const chat = state.activeChat;
    if (chat && chat.conversationId === message.conversationId) {
      if (chat.messages.some((entry) => entry.id === message.id)) return true;
      chat.messages.push(message);
      appendMessage(message, message.from === state.user.id);
      return true;
    }

    // The friend is online but this conversation is not open on this device.
    // Keep the message only in JavaScript memory and let the user open the
    // chat from the notification. Nothing is written to storage or PostgreSQL.
    const inbox = inboxFor(message.conversationId);
    if (!inbox) return false;
    if (inbox.some((entry) => entry.id === message.id)) return true;
    inbox.push(message);
    while (inbox.length > CHAT_INBOX_LIMIT) inbox.shift();
    notifyPrivateMessage(message);
    return true;
  }

  function markChatDisconnected() {
    // Invalidate any in-flight private:open request from the previous socket.
    state.chatOpenSeq += 1;
    clearChatInbox();
    const chat = state.activeChat;
    if (!chat) return;
    chat.ready = false;
    chat.conversationId = null;
    chat.peerOnline = false;
    chat.messages = [];
    chat.error = null;
    renderChatHeader();
    renderChatMessages();
  }

  async function restoreActiveChat() {
    const chat = state.activeChat;
    if (!chat?.friend || !state.socket?.connected) {
      renderChatHeader();
      return;
    }
    if (chat.restoring) return;
    chat.restoring = true;
    const seq = ++state.chatOpenSeq;
    chat.ready = false;
    chat.error = null;
    renderChatHeader();
    renderChatMessages();
    try {
      const response = await emitAck('private:open', { friendId: chat.friend.id });
      if (seq !== state.chatOpenSeq || state.activeChat !== chat) return;
      if (!response?.success) {
        chat.ready = false;
        chat.error = response?.message || 'Unable to restore this chat.';
        renderChatHeader();
        renderChatMessages();
        return;
      }
      chat.conversationId = response.conversation.id;
      chat.peerOnline = Boolean(response.conversation.peerOnline);
      chat.ready = true;
      chat.error = null;
      const pending = takeChatInbox(chat.conversationId);
      for (const message of pending) {
        if (!chat.messages.some((entry) => entry.id === message.id)) chat.messages.push(message);
      }
      renderChatMessages();
      renderChatHeader();
    } finally {
      chat.restoring = false;
    }
  }

  async function openChat(friendId) {
    let friend = state.friends.find((entry) => entry.id === friendId);
    if (!friend) {
      // A message can arrive immediately after reconnect, before social:ready
      // has repopulated the friend list. Refresh once before giving up.
      try { await loadSocial(); } catch (_) { /* keep the original error below */ }
      friend = state.friends.find((entry) => entry.id === friendId);
    }
    if (!friend) { toast('That friend is no longer in your list.', 'error'); return; }

    // Leave the previous conversation explicitly. The backend also enforces
    // one conversation per socket, but this keeps the transition immediate.
    const previous = state.activeChat;
    if (previous?.conversationId && state.socket?.connected) {
      state.socket.emit('private:leave', { conversationId: previous.conversationId });
    }
    clearChatMemory();

    const seq = ++state.chatOpenSeq;
    const chat = {
      friend,
      conversationId: null,
      messages: [],
      peerOnline: Boolean(friend.online),
      ready: false,
      error: null,
      restoring: false
    };
    state.activeChat = chat;
    showScreen('chat');
    renderChatHeader();
    renderChatMessages();

    if (!state.socket || !state.socket.connected) {
      toast('Connecting to the chat server…');
      // A freshly restored session or a socket teardown can leave no client at
      // all. Create one before waiting; waitForSocket cannot connect a null socket.
      if (!state.socket) connectSocket();
      const connected = await waitForSocket();
      if (seq !== state.chatOpenSeq || state.activeChat !== chat) return;
      if (!connected) {
        chat.error = 'Could not connect to the chat server. Check your connection and retry.';
        renderChatHeader();
        renderChatMessages();
        toast(chat.error, 'error');
        return;
      }
    }

    const response = await emitAck('private:open', { friendId });
    if (seq !== state.chatOpenSeq || state.activeChat !== chat) return;
    if (!response?.success) {
      chat.ready = false;
      chat.error = response?.message || 'Unable to open this chat.';
      renderChatHeader();
      renderChatMessages();
      toast(chat.error, 'error');
      return;
    }
    chat.conversationId = response.conversation.id;
    chat.peerOnline = Boolean(response.conversation.peerOnline);
    chat.ready = true;
    chat.error = null;
    // Deliberately ignore any messages field: reopened conversations are empty.
    // Only messages received on this device while the chat was closed are shown.
    const pending = takeChatInbox(chat.conversationId);
    for (const message of pending) {
      if (!chat.messages.some((entry) => entry.id === message.id)) chat.messages.push(message);
    }
    renderChatMessages();
    renderChatHeader();
    byId('tc-chat-input')?.focus();
  }

  function clearChatMemory() {
    state.chatOpenSeq += 1;
    state.activeChat = null;
    const container = byId('tc-chat-messages');
    if (container) container.innerHTML = '';
    showTyping(false);
    const input = byId('tc-chat-input');
    if (input) { input.value = ''; input.style.height = ''; }
    renderChatMessages();
  }

  function leaveChat() {
    if (state.activeChat?.conversationId && state.socket?.connected) {
      state.socket.emit('private:leave', { conversationId: state.activeChat.conversationId });
    }
    clearChatMemory();
    showScreen('friends', { fromBack: true });
  }

  function renderChatHeader() {
    const chat = state.activeChat;
    const friend = chat?.friend;
    if (!friend) return;
    const ready = Boolean(chat.ready);
    const online = ready && Boolean(chat.peerOnline);
    const avatar = byId('tc-chat-avatar');
    if (avatar) avatar.innerHTML = `${avatarInner(friend)}<span class="tc-dot ${online ? 'online' : ''}"></span>`;
    setText('tc-chat-name', displayNameOf(friend));
    const status = chat.error
      ? 'Not connected'
      : !ready
        ? 'Connecting…'
        : online
          ? 'Online'
          : friend.lastSeenAt
            ? `Last seen ${formatLastSeen(friend.lastSeenAt)}`
            : 'Offline';
    const statusEl = byId('tc-chat-status');
    if (statusEl) statusEl.innerHTML = `<span class="tc-dot ${online ? 'online' : ''}"></span>${esc(status)}`;
    const input = byId('tc-chat-input');
    const send = byId('tc-chat-send');
    const canSend = ready && Boolean(state.socket?.connected);
    if (input) input.disabled = !canSend;
    if (send) send.disabled = !canSend;
  }

  function renderChatNotice(message, { retry = false } = {}) {
    const container = byId('tc-chat-messages');
    if (!container) return;
    container.innerHTML = '';
    const notice = document.createElement('div');
    notice.className = 'tc-chat-empty';
    const icon = document.createElement('i');
    icon.className = retry ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-notch fa-spin';
    const title = document.createElement('strong');
    title.textContent = retry ? 'Chat could not open' : 'Connecting…';
    const copy = document.createElement('div');
    copy.textContent = String(message || '');
    notice.append(icon, title, copy);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tc-btn tc-btn-primary tc-btn-sm';
      button.dataset.action = 'retry-chat';
      button.style.marginTop = '10px';
      button.textContent = 'Retry';
      notice.appendChild(button);
    }
    container.appendChild(notice);
  }

  function renderChatMessages() {
    const container = byId('tc-chat-messages');
    if (!container) return;
    container.innerHTML = '';
    const chat = state.activeChat;
    if (!chat) return;
    if (chat.error) {
      renderChatNotice(chat.error, { retry: true });
      return;
    }
    if (!chat.ready) {
      renderChatNotice('Opening a temporary conversation…');
      return;
    }
    if (!chat.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'tc-chat-empty';
      empty.id = 'tc-chat-empty';
      empty.innerHTML = `<i class="fa-solid fa-lock"></i><strong>Temporary conversation</strong><div>Messages exist only while this chat is open. Leaving or disconnecting clears them, and reopening starts empty.</div>`;
      container.appendChild(empty);
      return;
    }
    for (const message of chat.messages) appendMessage(message, message.from === state.user?.id, true);
    scrollChatToBottom();
  }

  function appendMessage(message, mine, skipScroll = false) {
    const container = byId('tc-chat-messages');
    if (!container) return;
    byId('tc-chat-empty')?.remove();
    if (message?.id && container.querySelector(`[data-msg-id="${message.id}"]`)) return;
    const row = document.createElement('div');
    row.className = `tc-msg-row ${mine ? 'me' : 'them'}`;
    if (message.id) row.dataset.msgId = message.id;
    const bubble = document.createElement('div');
    bubble.className = 'tc-bubble';
    const text = document.createElement('div');
    text.textContent = String(message.text || '');
    const meta = document.createElement('div');
    meta.className = 'tc-msg-meta';
    const time = document.createElement('span');
    time.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);
    if (mine) {
      const status = document.createElement('span');
      status.dataset.statusFor = message.id || '';
      status.textContent = message.delivery === 'delivered' ? 'Delivered' : message.delivery === 'failed' ? 'Not delivered' : 'Sending…';
      meta.appendChild(status);
    }
    bubble.append(text, meta);
    row.appendChild(bubble);
    container.appendChild(row);
    if (!skipScroll) scrollChatToBottom();
  }

  function updateMessageStatus(id, text) {
    if (!id) return;
    const el = byId('tc-chat-messages')?.querySelector(`[data-status-for="${id}"]`);
    if (el) el.textContent = text;
  }

  function scrollChatToBottom() {
    const container = byId('tc-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function showTyping(visible) {
    const el = byId('tc-chat-typing');
    if (!el) return;
    el.textContent = visible ? 'Typing…' : '';
    clearTimeout(state.typingTimer);
    if (visible) state.typingTimer = setTimeout(() => { el.textContent = ''; }, 3500);
  }

  function emitTyping(isTyping) {
    if (!state.activeChat?.conversationId || !state.socket?.connected) return;
    const now = Date.now();
    if (isTyping && now - state.typingEmitAt < 1500) return;
    state.typingEmitAt = now;
    state.socket.emit('private:typing', { conversationId: state.activeChat.conversationId, isTyping });
  }

  async function sendMessage() {
    const input = byId('tc-chat-input');
    const text = String(input?.value || '').trim();
    if (!text) return;
    if (!state.activeChat?.ready || !state.activeChat?.conversationId) {
      toast('The chat is still opening. Wait a moment and try again.', 'error');
      return;
    }
    if (!state.socket?.connected) { toast('You are offline. Reconnect to send.', 'error'); return; }
    if (text.length > 4000) { toast('Messages are limited to 4000 characters.', 'error'); return; }

    const message = {
      id: newMessageId(),
      conversationId: state.activeChat.conversationId,
      from: state.user?.id,
      sender: displayNameOf(state.user),
      text,
      timestamp: Date.now(),
      delivery: 'sending'
    };
    state.activeChat.messages.push(message);
    appendMessage(message, true);
    if (input) { input.value = ''; input.style.height = ''; }
    emitTyping(false);

    const response = await emitAck('private:send', { conversationId: message.conversationId, id: message.id, text: message.text }, 10000);
    if (response?.delivered) {
      message.delivery = 'delivered';
      updateMessageStatus(message.id, 'Delivered');
      return;
    }
    message.delivery = 'failed';
    const reason = response?.reason;
    const label = reason === 'recipient_offline'
      ? 'Not delivered — friend is offline'
      : reason === 'recipient_unavailable'
        ? 'Not delivered — friend could not be reached'
        : reason === 'recipient_not_in_chat'
          ? 'Not delivered — friend is not in this chat'
          : reason === 'rate_limited'
            ? 'Not delivered — slow down'
            : reason === 'unauthorized'
              ? 'Not delivered — chat closed. Reopening…'
              : 'Not delivered';
    updateMessageStatus(message.id, label);
    if (reason === 'unauthorized') {
      // The socket was replaced or the conversation was cleaned up. Re-open
      // the chat so the user can retry without losing the screen.
      restoreActiveChat().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Friends and requests
  // ---------------------------------------------------------------------------

  async function searchUsers() {
    const input = byId('tc-search-input');
    const query = String(input?.value || '').trim();
    state.searchResults = [];
    if (query.length < 2) {
      renderSearchResults(query.length ? 'Type at least 2 characters.' : '');
      return;
    }
    setText('tc-search-status', 'Searching…');
    try {
      const data = await apiFetch(`/api/auth/users/search?q=${encodeURIComponent(query)}`);
      state.searchResults = data.users || [];
      renderSearchResults();
    } catch (error) {
      renderSearchResults(error.message);
    }
  }

  async function sendFriendRequest(username, button) {
    setBusy(button, true, 'Sending…');
    try {
      const result = await apiFetch('/api/auth/friend-requests', { method: 'POST', body: { username } });
      if (result.state === 'accepted' || result.state === 'already-friends') toast('You are now friends.', 'success');
      else toast('Friend request sent.', 'success');
      await loadSocial();
      await searchUsers();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(button, false);
    }
  }

  async function respondRequest(id, accept) {
    try {
      await apiFetch(`/api/auth/friend-requests/${encodeURIComponent(id)}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      toast(accept ? 'Friend request accepted.' : 'Friend request declined.', 'success');
      await loadSocial();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function cancelRequest(id) {
    try {
      await apiFetch(`/api/auth/friend-requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Request cancelled.', 'success');
      await loadSocial();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function removeFriend(id) {
    if (!window.confirm('Remove this friend? You will no longer be able to chat privately.')) return;
    try {
      await apiFetch(`/api/auth/friends/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeChat?.friend?.id === id) clearChatMemory();
      toast('Friend removed.', 'success');
      await loadSocial();
      showScreen('friends');
    } catch (error) { toast(error.message, 'error'); }
  }

  // ---------------------------------------------------------------------------
  // Profile and settings
  // ---------------------------------------------------------------------------

  async function openProfile(userId) {
    if (!userId) return;
    if (userId === state.user?.id) {
      state.viewedProfile = { self: true, user: state.user, friendsCount: state.friends.length, online: true };
      showScreen('profile');
      return;
    }
    const friend = state.friends.find((entry) => entry.id === userId);
    try {
      const data = await apiFetch(`/api/auth/users/${encodeURIComponent(userId)}`);
      state.viewedProfile = { self: false, user: { ...data.user, id: data.user.id }, friendsCount: data.friendsCount, online: Boolean(data.user.online), isFriend: Boolean(data.isFriend), fallbackFriend: friend };
      showScreen('profile');
    } catch (error) { toast(error.message, 'error'); }
  }

  function renderProfile() {
    const profile = state.viewedProfile;
    const container = byId('tc-profile-content');
    if (!container || !profile) return;
    const user = profile.user || {};
    const online = profile.self ? true : Boolean(profile.online);
    const friendCount = Number(profile.friendsCount ?? 0);
    const status = online ? 'Online now' : user.lastSeenAt ? `Last seen ${formatLastSeen(user.lastSeenAt)}` : 'Offline';
    container.innerHTML = `<div class="tc-profile-card tc-card">
      <span class="tc-avatar tc-avatar-lg">${avatarInner(user)}<span class="tc-dot ${online ? 'online' : ''}"></span></span>
      <h2>${esc(displayNameOf(user))}</h2>
      <p class="tc-handle">@${esc(user.username || 'unknown')}</p>
      <div class="tc-chips" style="margin-top:10px"><span class="tc-chip"><span class="tc-dot ${online ? 'online' : ''}"></span>${esc(status)}</span><span class="tc-chip"><i class="fa-solid fa-user-group"></i>${esc(friendCount)} friend${friendCount === 1 ? '' : 's'}</span></div>
      <div class="tc-profile-stats">
        <div><strong>${esc(friendCount)}</strong><span>Friends</span></div>
        <div><strong>${esc(formatDate(user.createdAt))}</strong><span>Joined</span></div>
      </div>
    </div>`;

    const edit = byId('tc-profile-form');
    const actions = byId('tc-profile-actions');
    const nonfriend = byId('tc-profile-nonfriend');
    if (edit) edit.classList.toggle('hidden', !profile.self);
    if (actions) actions.classList.toggle('hidden', profile.self || !profile.isFriend);
    if (nonfriend) nonfriend.classList.toggle('hidden', profile.self || Boolean(profile.isFriend));
    if (profile.self) {
      const nameInput = byId('tc-profile-display-name');
      const avatarInput = byId('tc-profile-avatar-url');
      if (nameInput && document.activeElement !== nameInput) nameInput.value = user.displayName || user.username || '';
      if (avatarInput && document.activeElement !== avatarInput) avatarInput.value = user.avatarUrl || '';
    } else if (profile.isFriend) {
      const chatButton = byId('tc-profile-chat');
      if (chatButton) chatButton.dataset.chatUser = user.id || '';
      const removeButton = byId('tc-profile-remove');
      if (removeButton) removeButton.dataset.removeFriend = user.id || '';
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const button = byId('tc-profile-save');
    setError('tc-profile-error', '');
    setBusy(button, true, 'Saving…');
    try {
      const displayName = String(byId('tc-profile-display-name')?.value || '').trim();
      const avatarUrl = String(byId('tc-profile-avatar-url')?.value || '').trim();
      const data = await apiFetch('/api/auth/me', { method: 'PATCH', body: { displayName, avatarUrl } });
      state.user = data.user;
      toast('Profile updated.', 'success');
      state.viewedProfile = { self: true, user: state.user, friendsCount: state.friends.length, online: true };
      renderProfile();
      renderAll();
    } catch (error) {
      setError('tc-profile-error', error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    const button = byId('tc-password-submit');
    setError('tc-password-error', '');
    const currentPassword = String(byId('tc-current-password')?.value || '');
    const newPassword = String(byId('tc-new-password')?.value || '');
    const confirmPassword = String(byId('tc-confirm-password')?.value || '');
    if (newPassword.length < 8) { setError('tc-password-error', 'Use a password between 8 and 128 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('tc-password-error', 'The new passwords do not match.'); return; }
    setBusy(button, true, 'Updating…');
    try {
      const data = await apiFetch('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      applySession(data);
      connectSocket();
      byId('tc-password-form')?.reset();
      toast('Password updated. Other sessions were signed out.', 'success');
    } catch (error) {
      setError('tc-password-error', error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function deleteAccount() {
    const password = String(byId('tc-delete-password')?.value || '');
    setError('tc-delete-error', '');
    if (!password) { setError('tc-delete-error', 'Enter your password to confirm account deletion.'); return; }
    if (!window.confirm('Delete your account permanently? Your profile and friend relationships will be removed. This cannot be undone.')) return;
    const button = byId('tc-delete-account');
    setBusy(button, true, 'Deleting…');
    try {
      await apiFetch('/api/auth/me', { method: 'DELETE', body: { password } });
      await clearSession();
      setAccountMode(true);
      showScreen('welcome');
      toast('Your account was deleted.', 'success');
    } catch (error) {
      setError('tc-delete-error', error.message);
      setBusy(button, false);
    }
  }

  function renderSettings() {
    setText('tc-settings-name', state.user ? `${displayNameOf(state.user)} · @${state.user.username}` : '');
    setText('tc-settings-friends', `${state.friends.length} friend${state.friends.length === 1 ? '' : 's'}`);
    setText('tc-settings-requests', `${state.requests.filter((request) => request.direction === 'incoming').length} pending`);
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  async function login(event) {
    event.preventDefault();
    setError('tc-login-error', '');
    setNotice('tc-login-notice', '');
    const button = byId('tc-login-submit');
    const username = String(byId('tc-login-username')?.value || '').trim();
    const password = String(byId('tc-login-password')?.value || '');
    if (!username || !password) { setError('tc-login-error', 'Enter your username and password.'); return; }
    setBusy(button, true, 'Signing in…');
    try {
      const data = await apiFetch('/api/auth/login', { method: 'POST', auth: false, body: { username, password } });
      await applySession(data);
      await enterApp();
    } catch (error) {
      setError('tc-login-error', error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function register(event) {
    event.preventDefault();
    setError('tc-register-error', '');
    const button = byId('tc-register-submit');
    const username = String(byId('tc-register-username')?.value || '').trim();
    const password = String(byId('tc-register-password')?.value || '');
    const confirmPassword = String(byId('tc-register-confirm')?.value || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { setError('tc-register-error', 'Username must be 3–24 characters using letters, numbers, or underscores.'); return; }
    if (password.length < 8 || password.length > 128) { setError('tc-register-error', 'Use a password between 8 and 128 characters.'); return; }
    if (password !== confirmPassword) { setError('tc-register-error', 'The passwords do not match.'); return; }
    setBusy(button, true, 'Creating…');
    try {
      await apiFetch('/api/auth/register', { method: 'POST', auth: false, body: { username, password } });
      byId('tc-register-form')?.reset();
      const loginUsername = byId('tc-login-username');
      if (loginUsername) loginUsername.value = username;
      byId('tc-login-password')?.focus();
      setNotice('tc-login-notice', 'Account created. Sign in with your username and password.');
      showScreen('login');
    } catch (error) {
      setError('tc-register-error', error.message);
    } finally {
      setBusy(button, false);
    }
  }

  let availabilityTimer;
  async function checkUsernameAvailability() {
    const input = byId('tc-register-username');
    const hint = byId('tc-register-hint');
    if (!input || !hint) return;
    const username = input.value.trim();
    hint.className = 'tc-hint';
    hint.textContent = '3–24 letters, numbers, or underscores.';
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return;
    hint.textContent = 'Checking availability…';
    try {
      const data = await apiFetch(`/api/auth/username-available?username=${encodeURIComponent(username)}`, { auth: false });
      if (data.available) {
        hint.textContent = 'That username is available.';
        hint.className = 'tc-hint ok';
      } else {
        hint.textContent = 'That username is already taken.';
        hint.className = 'tc-hint bad';
      }
    } catch (_) {
      hint.textContent = 'Could not check availability right now.';
    }
  }

  async function logout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: isNative ? { refreshToken: state.refreshToken } : undefined });
    } catch (_) { /* local sign-out still proceeds */ }
    await clearSession();
    setAccountMode(true);
    showScreen('welcome');
    toast('Signed out.', 'success');
  }

  async function handleSessionExpired() {
    await clearSession();
    setAccountMode(true);
    showScreen('welcome');
    toast('Your session expired. Sign in again.', 'error');
  }

  async function enterApp() {
    setAccountMode(true);
    showScreen('home', { reset: true });
    connectSocket();
    try {
      await loadSocial();
    } catch (error) {
      if (error.status === 401) await handleSessionExpired();
      else toast(error.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Boot and events
  // ---------------------------------------------------------------------------

  function bindEvents() {
    accountApp = byId('account-app');
    backButton = byId('tc-back-to-account');
    byId('tc-login-form')?.addEventListener('submit', login);
    byId('tc-register-form')?.addEventListener('submit', register);
    byId('tc-profile-form')?.addEventListener('submit', saveProfile);
    byId('tc-password-form')?.addEventListener('submit', changePassword);
    backButton?.addEventListener('click', backToAccount);
    byId('eka-notify-stack')?.addEventListener('click', handleEkaNotificationClick);
    byId('tc-restore-retry')?.addEventListener('click', retryRestore);
    byId('tc-restore-signin')?.addEventListener('click', restoreSignIn);

    const retryWhenOnline = () => { handleForeground(); };
    window.addEventListener('online', retryWhenOnline);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') retryWhenOnline();
    });
    try {
      window.TempChatNative?.App?.addListener?.('appStateChange', ({ isActive }) => {
        if (isActive) retryWhenOnline();
      })?.catch?.(() => {});
      window.TempChatNative?.Network?.addListener?.('networkStatusChange', (status) => {
        if (status?.connected) retryWhenOnline();
      })?.catch?.(() => {});
    } catch (_) { /* native listeners unavailable */ }

    byId('tc-register-username')?.addEventListener('input', () => {
      clearTimeout(availabilityTimer);
      availabilityTimer = setTimeout(checkUsernameAvailability, 450);
    });

    byId('tc-search-input')?.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(searchUsers, 350);
    });

    const chatInput = byId('tc-chat-input');
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
      if (chatInput.value.trim()) emitTyping(true);
    });
    chatInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    byId('tc-chat-send')?.addEventListener('click', sendMessage);

    accountApp?.addEventListener('click', (event) => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        const target = nav.getAttribute('data-nav');
        if (target === 'welcome' || target === 'login' || target === 'register') {
          setAccountMode(true);
          setError('tc-login-error', '');
          setError('tc-register-error', '');
        }
        if (SCREENS[target]) showScreen(target, { reset: Boolean(nav.closest('#tc-bottom-nav')) });
        return;
      }

      const chat = event.target.closest('[data-chat-user]');
      if (chat) { event.preventDefault(); openChat(chat.getAttribute('data-chat-user')); return; }

      const profile = event.target.closest('[data-profile-user]');
      if (profile) { event.preventDefault(); openProfile(profile.getAttribute('data-profile-user')); return; }

      const sendRequest = event.target.closest('[data-send-request]');
      if (sendRequest) { event.preventDefault(); sendFriendRequest(sendRequest.getAttribute('data-send-request'), sendRequest); return; }

      const accept = event.target.closest('[data-accept-request]');
      if (accept) { event.preventDefault(); respondRequest(accept.getAttribute('data-accept-request'), true); return; }

      const decline = event.target.closest('[data-decline-request]');
      if (decline) { event.preventDefault(); respondRequest(decline.getAttribute('data-decline-request'), false); return; }

      const cancel = event.target.closest('[data-cancel-request]');
      if (cancel) { event.preventDefault(); cancelRequest(cancel.getAttribute('data-cancel-request')); return; }

      const remove = event.target.closest('[data-remove-friend]');
      if (remove) { event.preventDefault(); removeFriend(remove.getAttribute('data-remove-friend')); return; }

      const friendsFilter = event.target.closest('[data-friends-filter]');
      if (friendsFilter) { state.friendsFilter = friendsFilter.getAttribute('data-friends-filter'); renderFriends(); return; }

      const requestsFilter = event.target.closest('[data-requests-filter]');
      if (requestsFilter) { state.requestsFilter = requestsFilter.getAttribute('data-requests-filter'); renderRequests(); return; }

      const action = event.target.closest('[data-action]');
      if (action) {
        event.preventDefault();
        const name = action.getAttribute('data-action');
        if (name === 'open-rooms') openRooms();
        else if (name === 'logout') logout();
        else if (name === 'leave-chat') leaveChat();
        else if (name === 'delete-account') deleteAccount();
        else if (name === 'refresh-social') loadSocial().catch((error) => toast(error.message, 'error'));
        else if (name === 'open-profile' && state.user) openProfile(state.user.id);
        else if (name === 'open-chat' && state.activeChat?.friend) openChat(state.activeChat.friend.id);
        else if (name === 'retry-chat' && state.activeChat?.friend) openChat(state.activeChat.friend.id);
      }
    });
  }

  function setRestoreState(message, { retry = false, signIn = false, spinner = true } = {}) {
    setText('tc-restore-status', message || '');
    const spinnerEl = byId('tc-restore-spinner');
    if (spinnerEl) spinnerEl.classList.toggle('hidden', !spinner);
    setVisible('tc-restore-retry', retry);
    setVisible('tc-restore-signin', signIn);
  }

  async function retryRestore() {
    if (state.restoring) return;
    state.restoring = true;
    state.restorePending = false;
    setRestoreState('Restoring your session…', { spinner: true });
    try {
      if (isNative && !state.refreshToken) state.refreshToken = await secureGet(REFRESH_KEY);
      if (await refreshSession()) {
        await enterApp();
        return;
      }
      if (refreshFailureReason() === 'expired') {
        await handleSessionExpired();
        return;
      }
      state.restorePending = true;
      setRestoreState('EKA cannot reach the server right now. Your session is saved on this device.', { retry: true, signIn: true, spinner: false });
    } finally {
      state.restoring = false;
    }
  }

  async function restoreSignIn() {
    await clearSession();
    state.restorePending = false;
    setAccountMode(true);
    showScreen('login', { reset: true });
  }

  async function boot() {
    if (state.booted) return;
    state.booted = true;
    accountApp = byId('account-app');
    backButton = byId('tc-back-to-account');

    const openingRoomLink = Boolean(new URLSearchParams(window.location.search).get('room'));
    if (openingRoomLink) setAccountMode(false);

    if (isNative) state.refreshToken = await secureGet(REFRESH_KEY);
    const canRestore = isNative ? Boolean(state.refreshToken) : true;

    if (!openingRoomLink) {
      setAccountMode(true);
      if (canRestore) {
        state.restoring = true;
        showScreen('restore', { reset: true });
        setRestoreState('Restoring your session…', { spinner: true });
      } else {
        showScreen('welcome', { reset: true });
      }
    }

    if (!canRestore) return;

    const restored = await refreshSession();
    state.restoring = false;
    if (restored) {
      state.restorePending = false;
      if (openingRoomLink) {
        connectSocket();
        loadSocial().catch(() => {});
      } else {
        await enterApp();
      }
      return;
    }

    if (openingRoomLink) return;

    if (refreshFailureReason() === 'expired') {
      await clearSession();
      setAccountMode(true);
      showScreen('welcome', { reset: true });
      return;
    }

    state.restorePending = true;
    setAccountMode(true);
    showScreen('restore', { reset: true });
    setRestoreState('EKA cannot reach the server right now. Your session is saved on this device.', { retry: true, signIn: true, spinner: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindEvents(); boot(); });
  } else {
    bindEvents();
    boot();
  }

  // Expose a tiny diagnostic surface without exposing tokens or messages.
  window.TempChatApp = Object.freeze({
    version: '1.2.0',
    isNative,
    get signedIn() { return Boolean(state.user); },
    get restorePending() { return state.restorePending; },
    retryRestore,
    openRooms,
    handleNativeBack,
    async prepareRoomReconnect(roomSocket, options = {}) {
      if (!roomSocket) return { ok: false, reason: 'unavailable' };
      const forceRefresh = Boolean(options.forceRefresh);
      const hadSession = Boolean(state.user || state.accessToken || state.refreshToken);
      const needsRefresh = forceRefresh || !accessTokenIsFresh();
      let refreshed = false;
      if (needsRefresh) {
        refreshed = await refreshSession();
        if (!refreshed) {
          if (!hadSession && !state.user && !state.accessToken && !state.refreshToken) {
            roomSocket.auth = {};
            return { ok: true, refreshed: false, guest: true };
          }
          return { ok: false, reason: refreshFailureReason() };
        }
      }
      roomSocket.auth = state.accessToken ? { accessToken: state.accessToken } : {};
      return { ok: true, refreshed };
    },
    async handleForeground() {
      if (state.restoring) return;
      if (!state.user) {
        if (!state.restorePending) return;
        state.restorePending = false;
        if (isNative && !state.refreshToken) state.refreshToken = await secureGet(REFRESH_KEY);
        if (await refreshSession()) {
          await enterApp();
        } else if (refreshFailureReason() === 'expired') {
          await handleSessionExpired();
        } else {
          state.restorePending = true;
        }
        return;
      }
      if (!accessTokenIsFresh()) {
        if (!(await refreshSession())) {
          if (refreshFailureReason() === 'expired') await handleSessionExpired();
          else toast('Could not refresh your session. Check your connection and try again.', 'error');
          return;
        }
      }
      if (!state.socket?.connected) {
        if (state.socket) {
          state.socket.auth = { accessToken: state.accessToken };
          state.socket.connect();
        } else {
          connectSocket();
        }
      } else if (state.activeChat && !state.activeChat.ready && state.currentScreen === 'chat') {
        restoreActiveChat().catch(() => {});
      }
    }
  });
})();
