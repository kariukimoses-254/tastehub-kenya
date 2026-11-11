const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const DEV_JWT_SECRET = 'tastehub-development-only-secret-do-not-use-in-production';
let jwtSecret = process.env.JWT_SECRET || '';

if (!jwtSecret) {
  if (isProduction) {
    throw new Error('JWT_SECRET must be set in production');
  }
  jwtSecret = DEV_JWT_SECRET;
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET is not set - using an insecure development secret.');
}

if (isProduction && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const port = int(process.env.PORT, 5000);

module.exports = {
  nodeEnv,
  isProduction,
  port,
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${port}`)
  ).replace(/\/+$/, ''),
  hqEmail: (process.env.HQ_EMAIL || '').trim().toLowerCase(),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'TasteHub Kenya <orders@tastehub.co.ke>',
  },
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  allowBootstrap: process.env.ALLOW_BOOTSTRAP === 'true',
  bootstrapToken: process.env.BOOTSTRAP_TOKEN || '',
  corsOrigins: list(process.env.CLIENT_ORIGIN),
  database: {
    host: process.env.DATABASE_HOST || process.env.MYSQLHOST || 'localhost',
    port: int(process.env.DATABASE_PORT || process.env.MYSQLPORT, 3306),
    user: process.env.DATABASE_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DATABASE_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DATABASE_NAME || process.env.MYSQLDATABASE || 'tastehub_kenya',
  },
  order: {
    maxLineItems: int(process.env.ORDER_MAX_LINE_ITEMS, 30),
    maxQuantityPerItem: int(process.env.ORDER_MAX_QUANTITY_PER_ITEM, 20),
    maxTotalItems: int(process.env.ORDER_MAX_TOTAL_ITEMS, 100),
  },
  auth: {
    minPasswordLength: int(process.env.MIN_PASSWORD_LENGTH, 12),
  },
};
