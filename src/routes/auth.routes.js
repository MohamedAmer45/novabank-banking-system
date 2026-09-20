import { queryOne, execute, withTransaction } from '../database.js';
import {
  hashPassword, verifyPassword, randomToken, randomDigits, nowIso, addHours
} from '../security.js';
import { audit, notify, publicUser, userSnapshot } from '../banking.js';
import { send, error, bodyJson, clientIp, QA_MODE } from '../lib/http.js';
import { bearer, requireAuth } from '../lib/access.js';

const MFA_CHALLENGE_MINUTES = 5;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 8;

function sessionHours(rememberDevice) {
  return rememberDevice ? 24 * 30 : 8;
}

async function openSession(user, rememberDevice, req, metadata = {}) {
  const token = randomToken();

  await execute(
    'INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)',
    token, user.id, addHours(sessionHours(rememberDevice)), nowIso()
  );
  await execute('UPDATE users SET last_login=? WHERE id=?', nowIso(), user.id);
  await audit(user.id, 'LOGIN', 'USER', user.id, 'SUCCESS', metadata, clientIp(req));

  return token;
}

export async function register(req, res) {
  const body = await bodyJson(req);

  if (!body.email || !body.password || !body.firstName || !body.lastName) {
    return error(res, 400, 'email, password, firstName and lastName are required.');
  }
  if (String(body.password).length < MIN_PASSWORD_LENGTH) {
    return error(res, 400, `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (await queryOne('SELECT id FROM users WHERE email=?', body.email)) {
    return error(res, 409, 'Email is already registered.');
  }

  const created = await withTransaction(async () => {
    const inserted = await execute(
      `INSERT INTO users (email,password_hash,first_name,last_name,phone,role,status,email_verified,mfa_enabled,mfa_code,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      body.email, hashPassword(body.password), body.firstName, body.lastName,
      body.phone || '', 'CUSTOMER', 'ACTIVE', 0, 1, '123456', nowIso()
    );
    const id = inserted.lastInsertRowid;

    await execute(
      'INSERT INTO kyc_profiles (user_id,status,updated_at) VALUES (?,?,?)',
      id, 'NOT_STARTED', nowIso()
    );

    const token = randomDigits(6);
    await execute(
      `INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at)
       VALUES (?,?,?,?,?)`,
      token, id, 'EMAIL', addHours(1), nowIso()
    );

    await audit(id, 'REGISTER', 'USER', id, 'SUCCESS', {}, clientIp(req));
    return { id, token };
  });

  return send(res, 201, {
    message: 'Registration successful. Verify the email before using banking services.',
    ...(QA_MODE ? { demoVerificationCode: created.token } : {})
  });
}

export async function verifyEmail(req, res) {
  const body = await bodyJson(req);

  const token = await queryOne(
    `SELECT * FROM verification_tokens
      WHERE token=? AND kind='EMAIL' AND used_at IS NULL AND expires_at>?`,
    body.code, nowIso()
  );
  if (!token) return error(res, 400, 'Verification code is invalid or expired.');

  await execute('UPDATE users SET email_verified=1 WHERE id=?', token.user_id);
  await execute('UPDATE verification_tokens SET used_at=? WHERE token=?', nowIso(), token.token);
  await audit(token.user_id, 'VERIFY_EMAIL', 'USER', token.user_id);

  return send(res, 200, { message: 'Email verified.' });
}

export async function login(req, res) {
  const body = await bodyJson(req);

  const user = await queryOne('SELECT * FROM users WHERE email=?', body.email || '');
  if (!user) return error(res, 401, 'Invalid email or password.');

  if (user.locked_until && user.locked_until > nowIso()) {
    return error(res, 423, `Account locked until ${user.locked_until}.`);
  }
  if (user.status !== 'ACTIVE') {
    return error(res, 403, `User is ${user.status}.`);
  }

  if (!verifyPassword(body.password || '', user.password_hash)) {
    const attempts = Number(user.failed_attempts) + 1;
    const lockedUntil = attempts >= LOCKOUT_THRESHOLD
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString()
      : null;

    await execute(
      'UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?',
      attempts, lockedUntil, user.id
    );
    await audit(user.id, 'LOGIN', 'USER', user.id, 'FAILED', { attempts }, clientIp(req));

    return error(
      res, 401,
      lockedUntil
        ? `Account locked for ${LOCKOUT_MINUTES} minutes after repeated failures.`
        : 'Invalid email or password.'
    );
  }

  await execute(
    'UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?', user.id
  );

  if (!user.email_verified) {
    return error(res, 403, 'Email verification required.');
  }

  if (user.mfa_enabled) {
    const challenge = randomToken(12);
    await execute(
      `INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at)
       VALUES (?,?,?,?,?)`,
      challenge, user.id, 'MFA',
      new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60000).toISOString(), nowIso()
    );

    return send(res, 200, {
      mfaRequired: true,
      challenge,
      demoCode: QA_MODE ? user.mfa_code : undefined
    });
  }

  const token = await openSession(user, body.rememberDevice, req);
  return send(res, 200, { token, user: publicUser(user) });
}

export async function verifyMfa(req, res) {
  const body = await bodyJson(req);

  const challenge = await queryOne(
    `SELECT * FROM verification_tokens
      WHERE token=? AND kind='MFA' AND used_at IS NULL AND expires_at>?`,
    body.challenge || '', nowIso()
  );
  if (!challenge) return error(res, 400, 'MFA challenge is invalid or expired.');

  const user = await queryOne('SELECT * FROM users WHERE id=?', challenge.user_id);

  if (String(body.code) !== String(user.mfa_code)) {
    await audit(user.id, 'MFA_VERIFY', 'USER', user.id, 'FAILED', {}, clientIp(req));
    return error(res, 401, 'Invalid one-time code.');
  }

  await execute(
    'UPDATE verification_tokens SET used_at=? WHERE token=?', nowIso(), challenge.token
  );

  const country = String(req.headers['x-qa-country'] || 'EG').toUpperCase();
  const token = await openSession(user, body.rememberDevice, req, { mfa: true, country });

  await notify(
    user.id, 'NEW_LOGIN', 'New sign-in',
    `A sign-in was completed from ${country} / ${clientIp(req)}.`
  );

  if (country !== 'EG') {
    await execute(
      `INSERT INTO fraud_alerts (user_id,rule_code,severity,status,description,created_at)
       VALUES (?,?,?,?,?,?)`,
      user.id, 'UNUSUAL_LOGIN', 'MEDIUM', 'OPEN',
      'Login originated outside the configured home country (EG).', nowIso()
    );
  }

  return send(res, 200, { token, user: publicUser(user) });
}

export async function logout(req, res) {
  const token = bearer(req);
  if (token) await execute('DELETE FROM sessions WHERE token=?', token);
  return send(res, 200, { message: 'Logged out.' });
}

export async function forgotPassword(req, res) {
  const body = await bodyJson(req);
  const user = await queryOne('SELECT * FROM users WHERE email=?', body.email || '');

  let token = null;

  if (user) {
    token = randomToken(16);
    await execute(
      `INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at)
       VALUES (?,?,?,?,?)`,
      token, user.id, 'PASSWORD_RESET', addHours(1), nowIso()
    );
    await notify(
      user.id, 'PASSWORD_RESET', 'Password reset requested',
      'A password reset was requested for your NovaBank profile.', 'EMAIL'
    );
    await audit(user.id, 'FORGOT_PASSWORD', 'USER', user.id);
  }

  /*
   * The response is identical whether or not the email exists, so the endpoint
   * cannot be used to enumerate registered addresses.
   */
  return send(res, 200, {
    message: 'If the email exists, a reset link has been issued.',
    ...(QA_MODE && token ? { demoResetToken: token } : {})
  });
}

export async function resetPassword(req, res) {
  const body = await bodyJson(req);

  const token = await queryOne(
    `SELECT * FROM verification_tokens
      WHERE token=? AND kind='PASSWORD_RESET' AND used_at IS NULL AND expires_at>?`,
    body.token || '', nowIso()
  );
  if (!token) return error(res, 400, 'Reset token is invalid or expired.');

  if (String(body.password || '').length < MIN_PASSWORD_LENGTH) {
    return error(res, 400, `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  await execute(
    'UPDATE users SET password_hash=?,failed_attempts=0,locked_until=NULL WHERE id=?',
    hashPassword(body.password), token.user_id
  );
  await execute('UPDATE verification_tokens SET used_at=? WHERE token=?', nowIso(), token.token);
  await execute('DELETE FROM sessions WHERE user_id=?', token.user_id);
  await notify(
    token.user_id, 'PASSWORD_CHANGED', 'Password changed',
    'Your password was reset successfully.'
  );
  await audit(token.user_id, 'RESET_PASSWORD', 'USER', token.user_id);

  return send(res, 200, { message: 'Password reset successfully.' });
}

export async function changePassword(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);
  const stored = await queryOne('SELECT * FROM users WHERE id=?', user.id);

  if (!verifyPassword(body.currentPassword || '', stored.password_hash)) {
    return error(res, 401, 'Current password is incorrect.');
  }
  if (String(body.newPassword || '').length < MIN_PASSWORD_LENGTH) {
    return error(res, 400, `New password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  await execute(
    'UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.newPassword), user.id
  );
  await notify(
    user.id, 'PASSWORD_CHANGED', 'Password changed', 'Your NovaBank password was changed.'
  );
  await audit(user.id, 'CHANGE_PASSWORD', 'USER', user.id);

  return send(res, 200, { message: 'Password changed.' });
}

export async function me(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  return send(res, 200, await userSnapshot(user.id));
}

export async function updateProfile(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  await execute(
    'UPDATE users SET first_name=?,last_name=?,phone=? WHERE id=?',
    body.firstName || user.first_name,
    body.lastName || user.last_name,
    body.phone ?? user.phone,
    user.id
  );
  await audit(user.id, 'UPDATE_PROFILE', 'USER', user.id);

  return send(res, 200, {
    user: publicUser(await queryOne('SELECT * FROM users WHERE id=?', user.id))
  });
}
