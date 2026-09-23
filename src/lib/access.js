import { queryOne } from '../database.js';
import { publicUser } from '../banking.js';
import { nowIso } from '../security.js';
import { error } from './http.js';

export const ROLE_PERMISSIONS = {
  CUSTOMER: [],
  SUPPORT: ['READ_CUSTOMERS', 'READ_ACCOUNTS', 'READ_TRANSFERS'],
  AUDITOR: ['READ_CUSTOMERS', 'READ_ACCOUNTS', 'READ_TRANSFERS', 'READ_AUDIT', 'READ_FRAUD'],
  EMPLOYEE: ['READ_CUSTOMERS', 'READ_ACCOUNTS', 'READ_TRANSFERS', 'REVIEW_KYC'],
  MANAGER: [
    'READ_CUSTOMERS', 'READ_ACCOUNTS', 'READ_TRANSFERS', 'READ_AUDIT', 'READ_FRAUD',
    'REVIEW_KYC', 'MANAGE_ACCOUNTS', 'MANAGE_LIMITS', 'REVERSE_TRANSFER',
    'REVIEW_LOANS', 'MANAGE_FRAUD'
  ],
  ADMIN: ['*']
};

export function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function authenticate(req) {
  const token = bearer(req);
  if (!token) return null;

  const session = await queryOne(
    `SELECT s.*, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
    token, nowIso()
  );

  return session ? publicUser(session) : null;
}

/*
 * Returns the authenticated user, or writes a 401 and returns null. Callers
 * bail out on null rather than throwing, which keeps the route handlers flat.
 */
export async function requireAuth(req, res) {
  const user = await authenticate(req);
  if (!user) {
    error(res, 401, 'Authentication required.');
    return null;
  }
  return user;
}

export function hasPermission(user, permission) {
  const granted = ROLE_PERMISSIONS[user.role] || [];
  return granted.includes('*') || granted.includes(permission);
}

/*
 * The permissions a role actually holds, with the wildcard expanded. The client
 * uses this to decide which navigation entries to offer, so that the sidebar
 * and the server's own checks are driven by one table rather than two lists
 * that drift apart. (BUG-UI-002)
 *
 * This is a convenience, not a boundary: every route still calls
 * requirePermission. Hiding a control has never been the authorization.
 */
export function permissionsFor(role) {
  const granted = ROLE_PERMISSIONS[role] || [];

  return granted.includes('*')
    ? [...new Set(Object.values(ROLE_PERMISSIONS).flat())].filter(p => p !== '*').sort()
    : [...granted].sort();
}

export async function requirePermission(req, res, permission) {
  const user = await requireAuth(req, res);
  if (!user) return null;

  if (!hasPermission(user, permission)) {
    error(res, 403, 'You do not have permission to perform this action.');
    return null;
  }

  return user;
}

export async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;

  if (user.role !== 'ADMIN') {
    error(res, 403, 'Administrator role required.');
    return null;
  }

  return user;
}

export async function ownAccount(userId, accountId) {
  return queryOne(
    'SELECT * FROM accounts WHERE id=? AND user_id=?', Number(accountId), userId
  );
}

export function sanitizeIdNumber(row) {
  if (!row) return row;

  const { document_data_b64, ...safe } = row;

  return {
    ...safe,
    id_number: row.id_number ? `**********${row.id_number.slice(-4)}` : null,
    has_document: Boolean(document_data_b64)
  };
}
