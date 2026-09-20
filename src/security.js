import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomDigits(length = 6) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

export function maskAccount(value = '') {
  const str = String(value);
  return str.length <= 4 ? str : `${'*'.repeat(Math.max(4, str.length - 4))}${str.slice(-4)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addHours(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}
