'use strict';

const path = require('node:path');
const hadMongoUriInProcessEnv = process.env.MONGODB_URI !== undefined;
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoUriSource = hadMongoUriInProcessEnv
  ? 'process.env (takes precedence over backend/.env)'
  : dotenvResult.parsed?.MONGODB_URI !== undefined
    ? 'backend/.env'
    : 'missing';

function required(name, value = process.env[name]) {
  if (!value || !String(value).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(value).trim();
}

function readConfig({ allowTestMode = false } = {}) {
  const testMode = allowTestMode && process.env.TEMPCHAT_TEST_MODE === 'true';
  const production = process.env.NODE_ENV === 'production';
  const config = {
    testMode: testMode && !production,
    production,
    port: Number(process.env.PORT || 3000),
    mongoUri: process.env.MONGODB_URI || '',
    mongoUriSource,
    mongoDbName: process.env.MONGODB_DB_NAME || 'tempchat',
    databaseUrl: process.env.DATABASE_URL || '',
    pgSsl: process.env.PG_SSL !== 'false' ? 'true' : 'false',
    jwtSecret: process.env.JWT_SECRET || '',
    webOrigin: process.env.APP_ORIGIN || 'https://tempchat-app-backend.onrender.com'
  };

  if (testMode) return config;
  required('DATABASE_URL', config.databaseUrl);
  required('JWT_SECRET', config.jwtSecret);
  if (Buffer.byteLength(config.jwtSecret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes of cryptographically random data.');
  }
  return config;
}

module.exports = { readConfig };
