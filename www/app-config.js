/*
 * Public client configuration. This endpoint contains no credentials.
 * Override it at build time for another deployment; never point a release APK
 * at localhost unless the backend is intentionally reachable from the device.
 */
window.TEMPCHAT_CONFIG = Object.freeze({
  apiUrl: 'https://tempchat-app-backend.onrender.com',
  socketUrl: 'https://tempchat-app-backend.onrender.com',
  publicBaseUrl: 'https://tempchat-app-backend.onrender.com'
});
