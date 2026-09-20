import { queryAll, queryOne, execute } from '../database.js';
import { nowIso } from '../security.js';
import {
  audit, notify, publicUser, userSnapshot, reverseTransfer, reviewLoan
} from '../banking.js';
import { send, error, bodyJson, sendFile, moneyMinor } from '../lib/http.js';
import {
  requirePermission, requireAdmin, sanitizeIdNumber
} from '../lib/access.js';

const KYC_DECISIONS = ['VERIFIED', 'REJECTED', 'NEEDS_MORE_INFORMATION', 'SUSPENDED'];
const FRAUD_STATUSES = ['OPEN', 'INVESTIGATING', 'CLEARED', 'CONFIRMED'];
const ASSIGNABLE_ROLES = ['CUSTOMER', 'SUPPORT', 'AUDITOR', 'EMPLOYEE', 'MANAGER', 'ADMIN'];

export async function dashboard(req, res) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  const [customers, activeAccounts, pendingKyc, openFraud, pendingLoans, volume] =
    await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM users WHERE role='CUSTOMER'"),
      queryOne("SELECT COUNT(*) AS count FROM accounts WHERE status='ACTIVE'"),
      queryOne(
        `SELECT COUNT(*) AS count FROM kyc_profiles
          WHERE status IN ('PENDING','UNDER_REVIEW','NEEDS_MORE_INFORMATION')`
      ),
      queryOne(
        "SELECT COUNT(*) AS count FROM fraud_alerts WHERE status IN ('OPEN','INVESTIGATING')"
      ),
      queryOne(
        "SELECT COUNT(*) AS count FROM loans WHERE status IN ('SUBMITTED','UNDER_REVIEW')"
      ),
      queryOne(
        "SELECT COALESCE(SUM(amount_minor),0) AS total FROM transfers WHERE status='COMPLETED'"
      )
    ]);

  return send(res, 200, {
    customers: Number(customers.count),
    activeAccounts: Number(activeAccounts.count),
    pendingKyc: Number(pendingKyc.count),
    openFraud: Number(openFraud.count),
    pendingLoans: Number(pendingLoans.count),
    transferVolumeMinor: Number(volume.total)
  });
}

export async function listCustomers(req, res, _params, url) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  const search = `%${url.searchParams.get('q') || ''}%`;

  return send(res, 200, await queryAll(
    `SELECT u.id,u.email,u.first_name,u.last_name,u.phone,u.status,
            u.email_verified,u.created_at,u.last_login,k.status AS kyc_status
       FROM users u
       LEFT JOIN kyc_profiles k ON k.user_id = u.id
      WHERE u.role='CUSTOMER'
        AND (u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)
      ORDER BY u.created_at DESC
      LIMIT 200`,
    search, search, search
  ));
}

export async function customerDetail(req, res, params) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  const id = Number(params[0]);

  const [snapshot, kyc, beneficiaries, transfers, loans] = await Promise.all([
    userSnapshot(id),
    queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', id),
    queryAll('SELECT * FROM beneficiaries WHERE user_id=?', id),
    queryAll('SELECT * FROM transfers WHERE user_id=? ORDER BY created_at DESC LIMIT 50', id),
    queryAll('SELECT * FROM loans WHERE user_id=? ORDER BY applied_at DESC', id)
  ]);

  return send(res, 200, {
    snapshot,
    kyc: sanitizeIdNumber(kyc),
    beneficiaries,
    transfers,
    loans
  });
}

export async function listKyc(req, res) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT k.id,k.user_id,k.status,k.date_of_birth,k.nationality,k.address,k.employment,
            k.annual_income_minor,k.id_type,k.id_number,k.document_name,k.document_mime,
            CASE WHEN k.document_data_b64 IS NOT NULL THEN 1 ELSE 0 END AS has_document,
            k.reviewer_note,k.reviewed_by,k.updated_at,u.email,u.first_name,u.last_name
       FROM kyc_profiles k
       JOIN users u ON u.id = k.user_id
      ORDER BY CASE k.status
                 WHEN 'UNDER_REVIEW' THEN 0
                 WHEN 'PENDING' THEN 1
                 ELSE 2
               END,
               k.updated_at DESC`
  ));
}

export async function kycDocument(req, res, params) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  const profile = await queryOne(
    'SELECT document_name,document_mime,document_data_b64 FROM kyc_profiles WHERE id=?',
    Number(params[0])
  );
  if (!profile?.document_data_b64) {
    return error(res, 404, 'No uploaded KYC document is stored.');
  }

  return sendFile(
    res,
    Buffer.from(profile.document_data_b64, 'base64'),
    profile.document_mime,
    profile.document_name || 'kyc-document'
  );
}

export async function reviewKyc(req, res, params) {
  const staff = await requirePermission(req, res, 'REVIEW_KYC');
  if (!staff) return;

  const body = await bodyJson(req);
  if (!KYC_DECISIONS.includes(body.status)) {
    return error(res, 400, 'Invalid KYC review status.');
  }

  const id = Number(params[0]);

  const existing = await queryOne('SELECT * FROM kyc_profiles WHERE id=?', id);
  if (!existing) return error(res, 404, 'KYC profile not found.');

  await execute(
    'UPDATE kyc_profiles SET status=?,reviewer_note=?,reviewed_by=?,updated_at=? WHERE id=?',
    body.status, body.note || '', staff.id, nowIso(), id
  );

  await notify(
    existing.user_id, 'KYC_REVIEW', 'Identity verification updated',
    `Your KYC status is now ${body.status}.`
  );
  await audit(staff.id, 'REVIEW_KYC', 'KYC', id, 'SUCCESS', { status: body.status });

  return send(res, 200, await queryOne('SELECT * FROM kyc_profiles WHERE id=?', id));
}

export async function listAccounts(req, res) {
  const staff = await requirePermission(req, res, 'READ_ACCOUNTS');
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT a.*, u.email, u.first_name, u.last_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
      ORDER BY a.opened_at DESC
      LIMIT 300`
  ));
}

export async function accountAction(req, res, params) {
  const action = params[1];
  const permission = action === 'limit' ? 'MANAGE_LIMITS' : 'MANAGE_ACCOUNTS';

  const staff = await requirePermission(req, res, permission);
  if (!staff) return;

  const account = await queryOne('SELECT * FROM accounts WHERE id=?', Number(params[0]));
  if (!account) return error(res, 404, 'Account not found.');

  const body = await bodyJson(req);

  if (action === 'freeze') {
    await execute("UPDATE accounts SET status='FROZEN' WHERE id=?", account.id);
  } else if (action === 'unfreeze' || action === 'activate') {
    await execute("UPDATE accounts SET status='ACTIVE' WHERE id=?", account.id);
  } else if (action === 'dormant') {
    await execute("UPDATE accounts SET status='DORMANT' WHERE id=?", account.id);
  } else {
    await execute(
      'UPDATE accounts SET daily_limit_minor=? WHERE id=?',
      moneyMinor(body.dailyLimit), account.id
    );
  }

  await notify(
    account.user_id, 'ACCOUNT_STATUS', 'Account updated',
    `Account ending ${account.account_number.slice(-4)} was updated by bank operations.`
  );
  await audit(staff.id, `${action.toUpperCase()}_ACCOUNT`, 'ACCOUNT', account.id, 'SUCCESS', body);

  return send(res, 200, await queryOne('SELECT * FROM accounts WHERE id=?', account.id));
}

export async function listTransfers(req, res) {
  const staff = await requirePermission(req, res, 'READ_TRANSFERS');
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT t.*, u.email, b.name AS beneficiary_name
       FROM transfers t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN beneficiaries b ON b.id = t.beneficiary_id
      ORDER BY t.created_at DESC
      LIMIT 300`
  ));
}

export async function reverse(req, res, params) {
  const staff = await requirePermission(req, res, 'REVERSE_TRANSFER');
  if (!staff) return;

  return send(res, 200, await reverseTransfer(staff.id, Number(params[0])));
}

export async function listLoans(req, res) {
  const staff = await requirePermission(req, res, 'READ_CUSTOMERS');
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT l.*, u.email, u.first_name, u.last_name
       FROM loans l
       JOIN users u ON u.id = l.user_id
      ORDER BY l.applied_at DESC`
  ));
}

export async function decideLoan(req, res, params) {
  const staff = await requirePermission(req, res, 'REVIEW_LOANS');
  if (!staff) return;

  const body = await bodyJson(req);

  return send(res, 200, await reviewLoan(
    staff.id, Number(params[0]), body.decision, body.note || ''
  ));
}

export async function listFraud(req, res) {
  const staff = await requirePermission(req, res, 'READ_FRAUD');
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT f.*, u.email, t.reference AS transfer_reference
       FROM fraud_alerts f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN transfers t ON t.id = f.transfer_id
      ORDER BY f.created_at DESC`
  ));
}

export async function updateFraud(req, res, params) {
  const staff = await requirePermission(req, res, 'MANAGE_FRAUD');
  if (!staff) return;

  const body = await bodyJson(req);
  if (!FRAUD_STATUSES.includes(body.status)) {
    return error(res, 400, 'Invalid fraud status.');
  }

  const id = Number(params[0]);
  const resolved = ['CLEARED', 'CONFIRMED'].includes(body.status) ? nowIso() : null;

  await execute(
    'UPDATE fraud_alerts SET status=?,assigned_to=?,resolution_note=?,resolved_at=? WHERE id=?',
    body.status, staff.id, body.note || '', resolved, id
  );
  await audit(staff.id, 'UPDATE_FRAUD_ALERT', 'FRAUD_ALERT', id, 'SUCCESS', body);

  return send(res, 200, await queryOne('SELECT * FROM fraud_alerts WHERE id=?', id));
}

export async function listAudit(req, res, _params, url) {
  const staff = await requirePermission(req, res, 'READ_AUDIT');
  if (!staff) return;

  const action = url.searchParams.get('action');
  const actor = url.searchParams.get('actor');

  let sql = `SELECT a.*, u.email AS actor_email
               FROM audit_logs a
               LEFT JOIN users u ON u.id = a.actor_user_id
              WHERE 1=1`;
  const params_ = [];

  if (action) { sql += ' AND a.action=?'; params_.push(action); }
  if (actor) { sql += ' AND a.actor_user_id=?'; params_.push(Number(actor)); }

  sql += ' ORDER BY a.created_at DESC LIMIT 500';

  return send(res, 200, await queryAll(sql, ...params_));
}

export async function listUsers(req, res) {
  const staff = await requireAdmin(req, res);
  if (!staff) return;

  return send(res, 200, await queryAll(
    `SELECT id,email,first_name,last_name,phone,role,status,
            email_verified,mfa_enabled,created_at,last_login
       FROM users
      ORDER BY created_at DESC`
  ));
}

export async function changeRole(req, res, params) {
  const staff = await requireAdmin(req, res);
  if (!staff) return;

  const body = await bodyJson(req);
  if (!ASSIGNABLE_ROLES.includes(body.role)) {
    return error(res, 400, 'Invalid role.');
  }

  const id = Number(params[0]);

  await execute('UPDATE users SET role=? WHERE id=?', body.role, id);
  await audit(staff.id, 'CHANGE_ROLE', 'USER', id, 'SUCCESS', { role: body.role });

  return send(res, 200, publicUser(
    await queryOne('SELECT * FROM users WHERE id=?', id)
  ));
}
