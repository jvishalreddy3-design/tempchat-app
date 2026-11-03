/* EKA first-launch onboarding and Android permission bridge.
 *
 * This module only owns consent, onboarding state, notification permission and
 * legal links. Authentication, rooms, friends, sockets and message handling are
 * intentionally left to the existing EKA modules.
 */
(function () {
  'use strict';

  const TERMS_KEY = 'eka.terms.v1';
  const ONBOARDING_KEY = 'eka.onboarding.v1';
  const TERMS_VERSION = '2026-11-01';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  const LEGAL = {
    terms: {
      kicker: 'EKA LEGAL',
      title: 'Terms & Conditions',
      body: `
        <p class="eka-legal-meta">Effective 1 November 2026 &middot; Version 1</p>
        <p>Welcome to EKA. These terms explain the rules for using the EKA app, including temporary rooms, private chats and account features. By continuing, you agree to these terms and to our Privacy Policy.</p>
        <h3>1. Using EKA</h3>
        <p>EKA is a private, real-time communication service. You must use it lawfully and only with people who have agreed to communicate with you. You are responsible for the activity on your account and for keeping your password secure.</p>
        <h3>2. Accounts and access</h3>
        <p>You may need an account for friends, private chats and saved preferences. Provide accurate information, do not impersonate another person, and do not share your account or access tokens. You are responsible for activity performed through your account.</p>
        <h3>3. Temporary conversations</h3>
        <p>EKA's temporary rooms and private chats are designed to be ephemeral. Messages are not intended to be a permanent record. A message may not be delivered if the recipient is offline, has left the conversation, or cannot receive it at that moment.</p>
        <h3>4. Acceptable use</h3>
        <p>Do not use EKA to harass, threaten, defraud, exploit or harm others; to distribute illegal content; to interfere with the service; or to attempt to access another person's account or conversations. We may suspend or end access when these rules are broken.</p>
        <h3>5. Content and permissions</h3>
        <p>You keep ownership of the content you send. You grant EKA only the limited permission needed to transmit that content to the people you choose. EKA requests Android permissions only when a feature needs them, and you can decline without losing access to unrelated features.</p>
        <h3>6. Service availability</h3>
        <p>EKA is provided on an as-available basis. Features may change, be interrupted, or be discontinued. To the extent permitted by law, EKA is not liable for lost temporary messages, missed connections, or interruptions outside its reasonable control.</p>
        <h3>7. Ending use</h3>
        <p>You may stop using EKA or delete your account from Settings at any time. We may limit or end access if you violate these terms or if doing so is necessary to protect people or the service.</p>
        <h3>8. Changes to these terms</h3>
        <p>We may update these terms as EKA evolves. When a material change is made, the updated terms will be shown in the app and may require your acceptance before you continue.</p>
      `
    },
    privacy: {
      kicker: 'EKA PRIVACY',
      title: 'Privacy Policy',
      body: `
        <p class="eka-legal-meta">Effective 1 November 2026 &middot; Version 1</p>
        <p>This policy explains what EKA keeps, why it is needed, and the choices you have. EKA is built to keep temporary conversations temporary.</p>
        <h3>Account information</h3>
        <p>When you create an account, EKA stores the information needed to operate it: your username, password credential, profile details you choose to add, friend connections and friend requests. Your password is handled as a credential and is not shown back to you in plain text.</p>
        <h3>Temporary conversations</h3>
        <p>Private chat messages and temporary-room messages are designed to stay out of the EKA database. They are held in memory while the conversation is active and are cleared when you leave or disconnect. Files and attachments are likewise intended to be temporary. If a recipient is offline or has not opened the conversation, a message may not be delivered and no permanent copy is kept.</p>
        <h3>Information on your device</h3>
        <p>EKA stores a small amount of data locally so the app works smoothly: your appearance preferences, your room-session token in secure storage, your Terms acceptance and onboarding state, and your notification choice. You can clear these by clearing EKA's app data or uninstalling the app.</p>
        <h3>Permissions</h3>
        <p>EKA asks for notification permission only after onboarding and only for messages, friend requests and important EKA updates. If EKA later offers camera, microphone or media features, Android will ask for those permissions only when you first use the relevant feature. Declining a permission does not grant EKA access to that feature.</p>
        <h3>Service providers</h3>
        <p>EKA uses infrastructure providers to host and transmit its service. Those providers process data only as needed to provide the service. We do not sell personal information or use private message content for advertising.</p>
        <h3>Security and retention</h3>
        <p>We use reasonable technical safeguards, including encrypted transport and secure on-device storage for session credentials. No system is perfectly secure. Account-level data is kept while your account is active, unless a longer period is required by law or needed to resolve abuse. Temporary conversation content is not intended to be retained.</p>
        <h3>Your choices</h3>
        <p>You can change or delete profile details, manage notifications in Android settings, log out, or delete your account from Settings. Deleting your account removes your profile and friend relationships; temporary conversations are not kept as an archive.</p>
        <h3>Changes</h3>
        <p>If this policy changes materially, EKA will show the updated policy in the app. The effective date at the top identifies the current version.</p>
      `
    }
  };

  let overlay = null;
  let termsStep = null;
  let notificationStep = null;
  let legalModal = null;
  let lastLegalTrigger = null;
  let notificationState = null;
  let notificationRequestResolved = false;
  let notificationBusy = false;
  let notificationLoading = false;
  let notificationRefreshToken = 0;
  let settingsBusy = false;
  let initialized = false;
  let memoryStorage = new Map();

  function byId(id) {
    return document.getElementById(id);
  }

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return memoryStorage.get(key) ?? null;
    }
  }

  function safeSet(key, value) {
    memoryStorage.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* In-memory persistence still protects the current session. */
    }
  }

  function readTermsAcceptance() {
    try {
      const value = JSON.parse(safeGet(TERMS_KEY) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function hasAcceptedCurrentTerms() {
    const acceptance = readTermsAcceptance();
    return Boolean(acceptance?.accepted && acceptance.version === TERMS_VERSION);
  }

  function isOnboardingComplete() {
    return safeGet(ONBOARDING_KEY) === 'complete';
  }

  function setOnboardingComplete() {
    safeSet(ONBOARDING_KEY, 'complete');
  }

  function isAndroidNative() {
    return Boolean(
      window.TempChatNative?.EkaPermissions ||
      (window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'android')
    );
  }

  function permissionPlugin() {
    return window.TempChatNative?.EkaPermissions || window.Capacitor?.Plugins?.EkaPermissions || null;
  }

  function setAppInert(inert) {
    for (const id of ['account-app', 'landing-view', 'entry-view', 'chat-view']) {
      const element = byId(id);
      if (!element) continue;
      if (inert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    }
    document.body?.classList.toggle('eka-onboarding-open', inert);
  }

  function markCompletedImmediately() {
    document.documentElement.classList.add('eka-onboarding-complete');
    document.body?.classList.remove('eka-onboarding-open');
    setAppInert(false);
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function finishOnboarding(decision) {
    setOnboardingComplete();
    safeSet('eka.notification.decision.v1', decision || 'later');
    const delay = reducedMotion ? 0 : 360;
    overlay?.classList.add('eka-onb-leaving');
    window.setTimeout(() => {
      markCompletedImmediately();
      refreshSettingsNotification();
    }, delay);
  }

  function syncTermsContinue() {
    const checkbox = byId('eka-onb-terms-checkbox');
    const button = byId('eka-onb-continue');
    if (!checkbox || !button) return;
    button.disabled = !checkbox.checked;
    button.setAttribute('aria-disabled', String(!checkbox.checked));
  }

  function focusStepTitle(step) {
    const title = byId(step === 'notifications' ? 'eka-onb-notice-title' : 'eka-onb-terms-title');
    title?.focus({ preventScroll: true });
  }

  function setActiveStep(step) {
    if (!overlay || !termsStep || !notificationStep) return;
    const showingTerms = step === 'terms';
    termsStep.classList.toggle('hidden', !showingTerms);
    notificationStep.classList.toggle('hidden', showingTerms);
    overlay.dataset.onboardingStep = step;
    overlay.setAttribute('aria-labelledby', showingTerms ? 'eka-onb-terms-title' : 'eka-onb-notice-title');
    overlay.setAttribute('aria-describedby', showingTerms ? 'eka-onb-terms-copy' : 'eka-onb-notice-copy');
    if (!reducedMotion) {
      const active = showingTerms ? termsStep : notificationStep;
      active.classList.remove('eka-onb-step-in');
      void active.offsetWidth;
      active.classList.add('eka-onb-step-in');
    }
    focusStepTitle(step);
  }

  function showTermsStep() {
    setActiveStep('terms');
    syncTermsContinue();
  }

  async function showNotificationStep() {
    setActiveStep('notifications');
    notificationRequestResolved = false;
    notificationState = null;
    const status = byId('eka-onb-notification-status');
    if (status) status.textContent = 'Checking your notification settings...';
    const primary = byId('eka-onb-notification-primary');
    if (primary) primary.disabled = true;
    await refreshNotificationStep();
  }

  function notificationPresentation(state) {
    if (!state || state.mode === 'web') {
      return {
        status: 'Notification permissions are managed by the installed EKA Android app.',
        primary: 'Continue',
        action: 'finish',
        offerSkip: false
      };
    }
    if (state.mode === 'unavailable' || state.mode === 'error') {
      return {
        status: 'Notification settings could not be read. You can manage them later in Settings.',
        primary: 'Continue',
        action: 'finish',
        offerSkip: false
      };
    }
    if (state.status === 'granted') {
      return {
        status: 'Notifications are on. You are all set.',
        primary: 'Continue',
        action: 'finish',
        offerSkip: false
      };
    }
    if (notificationRequestResolved) {
      return {
        status: state.status === 'disabled'
          ? 'Notifications are off in Android settings. You can enable them later in Settings.'
          : 'Notifications are off. You can enable them later in Settings.',
        primary: 'Continue',
        action: 'finish',
        offerSkip: false
      };
    }
    if (state.canPrompt) {
      return {
        status: 'Android will show its permission prompt next.',
        primary: 'Allow notifications',
        action: 'request',
        offerSkip: true
      };
    }
    return {
      status: 'Notifications are off. Enable them in Android settings whenever you are ready.',
      primary: 'Open Android settings',
      action: 'settings',
      offerSkip: true
    };
  }

  function applyNotificationStep() {
    const presentation = notificationPresentation(notificationState);
    const status = byId('eka-onb-notification-status');
    const primary = byId('eka-onb-notification-primary');
    const skip = byId('eka-onb-notification-skip');
    if (status) {
      status.textContent = presentation.status;
      status.dataset.tone = notificationState?.status === 'granted' ? 'success' : 'neutral';
    }
    if (primary) {
      primary.disabled = notificationBusy || notificationLoading;
      primary.dataset.action = presentation.action;
      primary.textContent = notificationBusy
        ? 'Requesting...'
        : notificationLoading ? 'Checking...' : presentation.primary;
    }
    if (skip) {
      skip.classList.toggle('hidden', !presentation.offerSkip);
      skip.disabled = notificationBusy || notificationLoading;
    }
  }

  async function readNotificationState() {
    if (!isAndroidNative()) return { mode: 'web', status: 'unsupported' };
    const plugin = permissionPlugin();
    if (!plugin?.checkNotificationPermission) return { mode: 'unavailable', status: 'unsupported' };
    try {
      const result = await plugin.checkNotificationPermission();
      return { mode: 'native', ...result };
    } catch (error) {
      console.warn('Unable to read EKA notification permission:', error);
      return { mode: 'error', status: 'unknown' };
    }
  }

  async function refreshNotificationStep() {
    const token = ++notificationRefreshToken;
    notificationLoading = true;
    const primary = byId('eka-onb-notification-primary');
    const skip = byId('eka-onb-notification-skip');
    if (primary) {
      primary.disabled = true;
      primary.textContent = 'Checking...';
    }
    if (skip) skip.disabled = true;
    try {
      const state = await readNotificationState();
      if (token !== notificationRefreshToken) return;
      notificationState = state;
    } finally {
      if (token === notificationRefreshToken) {
        notificationLoading = false;
        applyNotificationStep();
      }
    }
  }

  async function requestNotificationPermission() {
    const plugin = permissionPlugin();
    if (!plugin?.requestNotificationPermission || notificationBusy) return null;
    notificationBusy = true;
    applyNotificationStep();
    try {
      notificationState = { mode: 'native', ...(await plugin.requestNotificationPermission()) };
    } catch (error) {
      console.warn('Unable to request notification permission:', error);
      notificationState = { mode: 'error', status: 'unknown' };
    } finally {
      notificationBusy = false;
      notificationRequestResolved = true;
      applyNotificationStep();
      refreshSettingsNotification();
    }
    return notificationState;
  }

  async function openAndroidNotificationSettings() {
    const plugin = permissionPlugin();
    if (!plugin?.openNotificationSettings) return false;
    try {
      const result = await plugin.openNotificationSettings();
      return Boolean(result?.opened);
    } catch (error) {
      console.warn('Unable to open Android notification settings:', error);
      return false;
    }
  }

  async function handleNotificationPrimary() {
    if (notificationBusy) return;
    const action = byId('eka-onb-notification-primary')?.dataset.action || 'finish';
    if (action === 'finish') {
      finishOnboarding(notificationState?.status === 'granted' ? 'granted' : 'later');
      return;
    }
    if (action === 'settings') {
      await openAndroidNotificationSettings();
      return;
    }
    if (action === 'request') {
      await requestNotificationPermission();
    }
  }

  function notificationSettingsPresentation(state) {
    if (!isAndroidNative()) {
      return { status: 'Notification controls are available in the EKA Android app.', label: '', showButton: false };
    }
    if (!state || state.mode === 'unavailable' || state.mode === 'error') {
      return { status: 'Unable to read notification status.', label: 'Open Android settings', showButton: true, action: 'settings' };
    }
    if (state.status === 'granted') {
      return { status: 'On. New messages and friend requests can reach you.', label: 'Manage', showButton: true, action: 'settings' };
    }
    if (state.status === 'denied' && state.canPrompt) {
      return { status: 'Off. Allow notifications to hear about new messages and requests.', label: 'Enable', showButton: true, action: 'request' };
    }
    if (state.status === 'disabled') {
      return { status: 'Off in Android settings. Tap to turn notifications back on.', label: 'Open settings', showButton: true, action: 'settings' };
    }
    return { status: 'Off. Turn notifications on in Android settings whenever you are ready.', label: 'Open settings', showButton: true, action: 'settings' };
  }

  function applySettingsNotification(state) {
    const status = byId('eka-notification-setting-status');
    const button = byId('eka-notification-setting-button');
    if (!status || !button) return;
    const presentation = notificationSettingsPresentation(state);
    status.textContent = presentation.status;
    button.classList.toggle('hidden', !presentation.showButton);
    button.textContent = presentation.label;
    button.dataset.action = presentation.action || '';
  }

  let settingsRefreshToken = 0;
  async function refreshSettingsNotification() {
    const status = byId('eka-notification-setting-status');
    if (!status) return;
    const token = ++settingsRefreshToken;
    if (isAndroidNative()) status.textContent = 'Checking Android notification status...';
    const state = await readNotificationState();
    if (token !== settingsRefreshToken) return;
    applySettingsNotification(state);
  }

  async function handleSettingsNotification() {
    if (settingsBusy) return;
    const button = byId('eka-notification-setting-button');
    const state = await readNotificationState();
    if (!state || state.mode !== 'native') return;
    settingsBusy = true;
    if (button) button.disabled = true;
    try {
      if (state.status === 'granted' || state.status === 'disabled' || !state.canPrompt) {
        const opened = await openAndroidNotificationSettings();
        if (!opened) {
          const status = byId('eka-notification-setting-status');
          if (status) status.textContent = 'Open Android Settings and choose EKA to manage notifications.';
        }
      } else {
        const result = await requestNotificationPermission();
        if (result && result.status === 'denied') {
          const status = byId('eka-notification-setting-status');
          if (status) status.textContent = 'Notifications remain off. Use Open settings to enable them later.';
        }
      }
    } finally {
      settingsBusy = false;
      if (button) button.disabled = false;
      await refreshSettingsNotification();
    }
  }

  function openLegal(type) {
    if (!legalModal || !LEGAL[type]) return;
    lastLegalTrigger = document.activeElement;
    const body = byId('eka-legal-body');
    const title = byId('eka-legal-title');
    const kicker = byId('eka-legal-kicker');
    if (title) title.textContent = LEGAL[type].title;
    if (kicker) kicker.textContent = LEGAL[type].kicker;
    if (body) {
      body.innerHTML = LEGAL[type].body;
      body.scrollTop = 0;
    }
    legalModal.classList.remove('hidden');
    legalModal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => byId('eka-legal-close')?.focus(), 40);
  }

  function closeLegal() {
    if (!legalModal || legalModal.classList.contains('hidden')) return;
    legalModal.classList.add('hidden');
    legalModal.setAttribute('aria-hidden', 'true');
    if (lastLegalTrigger && document.contains(lastLegalTrigger)) lastLegalTrigger.focus();
    lastLegalTrigger = null;
  }

  function focusableIn(container) {
    return [...container.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.disabled && element.getClientRects().length > 0);
  }

  function trapFocus(container, event) {
    const focusable = focusableIn(container);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const currentIndex = focusable.indexOf(document.activeElement);
    if (currentIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function bindEvents() {
    byId('eka-onb-terms-checkbox')?.addEventListener('change', syncTermsContinue);

    byId('eka-onb-consent')?.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input')) return;
      const checkbox = byId('eka-onb-terms-checkbox');
      if (!checkbox) return;
      checkbox.checked = !checkbox.checked;
      syncTermsContinue();
    });

    byId('eka-onb-continue')?.addEventListener('click', () => {
      if (!byId('eka-onb-terms-checkbox')?.checked) return;
      safeSet(TERMS_KEY, JSON.stringify({
        accepted: true,
        version: TERMS_VERSION,
        acceptedAt: new Date().toISOString()
      }));
      showNotificationStep();
    });

    byId('eka-onb-notification-primary')?.addEventListener('click', handleNotificationPrimary);
    byId('eka-onb-notification-skip')?.addEventListener('click', () => {
      if (notificationBusy) return;
      finishOnboarding('later');
    });

    document.addEventListener('click', (event) => {
      const legalButton = event.target.closest('[data-eka-legal]');
      if (legalButton) {
        event.preventDefault();
        openLegal(legalButton.getAttribute('data-eka-legal'));
        return;
      }

      if (event.target.closest('[data-eka-legal-close]')) {
        event.preventDefault();
        closeLegal();
        return;
      }

      if (event.target.closest('[data-eka-action="notifications"]')) {
        event.preventDefault();
        handleSettingsNotification();
        return;
      }

      if (event.target.closest('[data-nav="settings"], [data-home-nav="settings"]')) {
        window.setTimeout(refreshSettingsNotification, 80);
      }
    });

    document.addEventListener('keydown', (event) => {
      const legalOpen = legalModal && !legalModal.classList.contains('hidden');
      if (event.key === 'Escape' && legalOpen) {
        event.preventDefault();
        closeLegal();
        return;
      }
      if (event.key !== 'Tab') return;
      if (legalOpen) {
        trapFocus(legalModal, event);
        return;
      }
      if (overlay && !overlay.classList.contains('hidden') && !isOnboardingComplete()) {
        trapFocus(overlay, event);
      }
    });

    window.TempChatNative?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      refreshSettingsNotification();
      if (notificationStep && !notificationStep.classList.contains('hidden') && !isOnboardingComplete()) {
        refreshNotificationStep();
      }
    });
  }

  function initOnboarding() {
    if (initialized) return;
    initialized = true;
    overlay = byId('eka-onboarding');
    termsStep = byId('eka-onb-step-terms');
    notificationStep = byId('eka-onb-step-notifications');
    legalModal = byId('eka-legal-modal');
    if (!overlay || !termsStep || !notificationStep) return;

    bindEvents();
    refreshSettingsNotification();

    if (isOnboardingComplete()) {
      markCompletedImmediately();
      return;
    }

    setAppInert(true);
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    if (hasAcceptedCurrentTerms()) {
      showNotificationStep();
    } else {
      showTermsStep();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOnboarding);
  } else {
    initOnboarding();
  }

  window.EkaOnboarding = Object.freeze({
    openLegal,
    closeLegal,
    isOnboardingComplete,
    refreshSettingsNotification,
    openNotificationSettings() {
      const action = byId('eka-notification-setting-button')?.dataset.action;
      if (action === 'request') return requestNotificationPermission();
      return openAndroidNotificationSettings();
    }
  });
})();
