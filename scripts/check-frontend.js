const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['frontend/index.html', 'www/index.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scripts.exec(html))) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1], { filename: `${file}#inline-${++count}` });
  }
  console.log(`${file}: parsed ${count} inline scripts`);
}

const nativeHtml = fs.readFileSync('www/index.html', 'utf8');
for (const required of [
  'TEMPCHAT ANDROID BOOTSTRAP',
  'https://tempchat-app-backend.onrender.com',
  'native-plugins.js',
  'room-empty-notice',
  'message:delivered',
  '/^\\d{6}$/'
]) {
  if (!nativeHtml.includes(required)) throw new Error(`Android bundle is missing expected frontend marker: ${required}`);
}
console.log('Android bundle includes the configured production endpoint and current TempChat UI/reliability changes.');

const home = nativeHtml.match(/<section id="screen-home"[\s\S]*?<\/section>/)?.[0] || '';
for (const required of [
  'eka-home-hero',
  'eka-stat-row',
  'tc-home-name',
  'tc-home-online',
  'tc-home-offline',
  'tc-home-requests-badge',
  'eka-bell-badge',
  'data-action="open-rooms"'
]) {
  if (!home.includes(required)) throw new Error(`EKA home is missing expected UI: ${required}`);
}
const bottomNav = nativeHtml.match(/<nav id="tc-bottom-nav"[\s\S]*?<\/nav>/)?.[0] || '';
const navTargets = [...bottomNav.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(navTargets) !== JSON.stringify(['home', 'friends', 'requests', 'settings'])) {
  throw new Error(`Bottom navigation must be exactly Home, Friends, Requests, Settings; found: ${navTargets.join(', ')}`);
}
for (const marker of ['appStateChange', 'SecureStorage.set(ROOM_SESSION_KEY', 'prepareRoomReconnect', 'handleNativeBack']) {
  if (!nativeHtml.includes(marker)) throw new Error(`Android bundle is missing persistence/navigation marker: ${marker}`);
}
for (const marker of ['roomReconnectPromise', "reason === 'io server disconnect'", 'forceRefresh: true']) {
  if (!nativeHtml.includes(marker)) throw new Error(`Android bundle is missing room session recovery marker: ${marker}`);
}
for (const file of ['frontend/assets/tempchat-app.js', 'www/assets/tempchat-app.js']) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of [
    'accessTokenExpiresAt',
    'refreshPromise',
    'prepareRoomReconnect(roomSocket, options',
    'forceRefresh',
    'acceptIncomingMessage',
    'restoreActiveChat',
    'chatInbox',
    "reason === 'recipient_unavailable'",
    "name === 'retry-chat'"
  ]) {
    if (!source.includes(marker)) throw new Error(`${file} is missing private-chat delivery marker: ${marker}`);
  }
}
console.log('Room session refresh/reconnect and private-chat delivery markers validated in frontend and Android bundle.');
const backHandler = nativeHtml.match(/addListener\?\.\('backButton',[\s\S]*?Native back handling is unavailable/)?.[0] || '';
if (backHandler.includes('leaveRoom()')) throw new Error('Android system back must not explicitly leave an active room.');
console.log('EKA home structure, exact four-item bottom navigation, secure room restoration, and non-destructive Android back handling validated.');

// Secure one-to-one temporary rooms and the join-requests layout guard.
for (const [file, html] of [['frontend/index.html', fs.readFileSync('frontend/index.html', 'utf8')], ['www/index.html', nativeHtml]]) {
  for (const required of [
    'id="join-requests-popover"',
    'join-requests-panel',
    'join-requests-list',
    'private-room:create',
    'private-room:accept',
    'private-room:notification',
    'private-room:closed',
    'private-room:expired'
  ]) {
    if (!html.includes(required)) throw new Error(`${file} is missing private-room marker: ${required}`);
  }
  const joinRequestsTag = html.match(/<section id="join-requests-popover"[^>]*>/)?.[0] || '';
  if (!joinRequestsTag || /\babsolute\b/.test(joinRequestsTag)) {
    throw new Error(`${file} join requests must be an in-flow section, not an absolutely positioned overlay.`);
  }
  const headerEnd = html.indexOf('</header>');
  const joinRequestsStart = html.indexOf('id="join-requests-popover"');
  const messageStart = html.indexOf('id="message-container"');
  if (!(headerEnd !== -1 && joinRequestsStart > headerEnd && messageStart > joinRequestsStart)) {
    throw new Error(`${file} join requests must sit between the room header and the message stage.`);
  }
  if (!/id="message-container"[^>]*\bmin-h-0\b/.test(html)) {
    throw new Error(`${file} message stage must shrink inside the flex column (min-h-0).`);
  }
}
for (const file of ['frontend/assets/tempchat-app.js', 'www/assets/tempchat-app.js']) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of [
    'createPrivateRoom',
    'acceptPrivateInvitation',
    'onPrivateInvitation',
    'onPrivateInvitationConsumed',
    'onPrivateInvitationExpired',
    'onPrivateRoomExit',
    'data-join-private-room',
    'notifyPrivateInvitation'
  ]) {
    if (!source.includes(marker)) throw new Error(`${file} is missing private-room chat marker: ${marker}`);
  }
}
console.log('Private temporary room flow and non-overlapping join-requests layout validated in frontend and Android bundle.');

const frontendHtml = fs.readFileSync('frontend/index.html', 'utf8');
for (const [file, html] of [['frontend/index.html', frontendHtml], ['www/index.html', nativeHtml]]) {
  for (const required of [
    'eka-onboarding.js',
    'eka-onboarding.css',
    'eka.onboarding.v1',
    'eka-onb-terms-checkbox',
    'eka-onb-notification-primary',
    'eka-legal-modal',
    'eka-notification-setting-status',
    'data-eka-legal="terms"'
  ]) {
    if (!html.includes(required)) throw new Error(`${file} is missing onboarding marker: ${required}`);
  }
  if (html.indexOf('id="eka-onb-step-terms"') > html.indexOf('id="eka-onb-step-notifications"')) {
    throw new Error(`${file} must present Terms before the notification explanation.`);
  }
}
for (const file of ['frontend/assets/eka-onboarding.js', 'www/assets/eka-onboarding.js']) {
  const source = fs.readFileSync(file, 'utf8');
  new vm.Script(source, { filename: file });
  for (const marker of [
    "TERMS_KEY = 'eka.terms.v1'",
    "ONBOARDING_KEY = 'eka.onboarding.v1'",
    'EkaPermissions',
    'requestNotificationPermission',
    'openNotificationSettings',
    'notificationRequestResolved'
  ]) {
    if (!source.includes(marker)) throw new Error(`${file} is missing onboarding behavior: ${marker}`);
  }
}
const onboardingCss = fs.readFileSync('frontend/assets/eka-onboarding.css', 'utf8');
for (const marker of ['html.eka-onboarding-complete .eka-onb', '.eka-legal-backdrop', 'prefers-reduced-motion']) {
  if (!onboardingCss.includes(marker)) throw new Error(`Onboarding styles are missing: ${marker}`);
}
const nativeEntry = fs.readFileSync('scripts/native-plugin-entry.js', 'utf8');
if (!nativeEntry.includes("registerPlugin('EkaPermissions')") || !nativeEntry.includes('EkaPermissions')) {
  throw new Error('Native plugin entry must expose the EkaPermissions bridge.');
}
const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
  throw new Error('AndroidManifest.xml must declare POST_NOTIFICATIONS.');
}
if (/android\.permission\.(CAMERA|RECORD_AUDIO)/.test(manifest)) {
  throw new Error('EKA must not declare unused camera or microphone permissions.');
}
const permissionPlugin = fs.readFileSync('android/app/src/main/java/com/tempchat/app/EkaPermissionsPlugin.java', 'utf8');
for (const marker of [
  'requestPermissionForAlias("notifications"',
  'ACTION_APP_NOTIFICATION_SETTINGS',
  'notification_permission_requested',
  'canPrompt'
]) {
  if (!permissionPlugin.includes(marker)) throw new Error(`Native permission plugin is missing: ${marker}`);
}
const mainActivity = fs.readFileSync('android/app/src/main/java/com/tempchat/app/MainActivity.java', 'utf8');
if (!mainActivity.includes('registerPlugin(EkaPermissionsPlugin.class)')) {
  throw new Error('MainActivity must register EkaPermissions before super.onCreate.');
}
console.log('First-launch consent ordering, Android notification bridge, manifest permission, legal UI, and unused-media-permission guard validated.');
