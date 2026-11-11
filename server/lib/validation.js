const { HttpError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Kenyan mobile numbers: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX
const PHONE_RE = /^(?:\+?254|0)(?:7|1)\d{8}$/;

function cleanString(value, { max = 255, field = 'value', required = false, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, `${field} must be text`);
  }
  const text = trim ? String(value).trim() : String(value);
  if (required && !text) throw new HttpError(400, `${field} is required`);
  if (text.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return text || null;
}

function requiredString(value, options = {}) {
  return cleanString(value, { ...options, required: true });
}

function optionalString(value, options = {}) {
  return cleanString(value, options);
}

function normalisePhone(value, { required = true, field = 'Phone number' } = {}) {
  const raw = cleanString(value, { max: 40, field, required });
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  if (!PHONE_RE.test(compact)) {
    throw new HttpError(400, `${field} must be a valid Kenyan mobile number`);
  }
  return compact;
}

function normaliseEmail(value, { required = false, field = 'Email' } = {}) {
  const raw = cleanString(value, { max: 190, field, required });
  if (!raw) return null;
  const email = raw.toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, `${field} is invalid`);
  return email;
}

function positiveInt(value, { field = 'value', min = 1, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

function oneOf(value, allowed, { field = 'value', fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw new HttpError(400, `${field} is required`);
  }
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new HttpError(400, 'Expected a true/false value');
}

module.exports = {
  EMAIL_RE,
  PHONE_RE,
  cleanString,
  requiredString,
  optionalString,
  normalisePhone,
  normaliseEmail,
  positiveInt,
  oneOf,
  booleanFlag,
};
