import { queryAll, queryOne, execute } from '../database.js';
import { nowIso, randomToken } from '../security.js';
import {
  audit, notify, executeTransfer, processBillPayment,
  calculateLoanPayment, payLoan
} from '../banking.js';
import {
  send, error, bodyJson, sendFile, moneyMinor, QA_MODE
} from '../lib/http.js';
import { requireAuth, ownAccount, sanitizeIdNumber } from '../lib/access.js';

const ACCOUNT_TYPES = ['CURRENT', 'SAVINGS'];
const CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP'];
const LOAN_TERMS = [12, 24, 36, 48, 60];
const MIN_LOAN_MINOR = 100000;
const BENEFICIARY_OTP = '123456';

function uniqueAccountNumber() {
  return String(1000000000 + Math.floor(Math.random() * 8999999999));
}

function uniqueIban(accountNumber) {
  const branch = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  return `EG38${branch}${accountNumber.padStart(20, '0').slice(-20)}`;
}

function isUniqueViolation(err) {
  // 23505 is PostgreSQL's unique_violation.
  return err?.code === '23505' || String(err).includes('duplicate key');
}

// --------------------------------------------------------------- KYC

export async function getKyc(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, sanitizeIdNumber(
    await queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', user.id)
  ));
}

export async function getKycDocument(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const profile = await queryOne(
    'SELECT document_name,document_mime,document_data_b64 FROM kyc_profiles WHERE user_id=?',
    user.id
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

export async function submitKyc(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);
  const profile = await queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', user.id);

  if (profile) {
    await execute(
      `UPDATE kyc_profiles
          SET status=?,date_of_birth=?,nationality=?,address=?,employment=?,
              annual_income_minor=?,id_type=?,id_number=?,document_name=?,
              document_mime=COALESCE(?,document_mime),
              document_data_b64=COALESCE(?,document_data_b64),
              reviewer_note=NULL,reviewed_by=NULL,updated_at=?
        WHERE user_id=?`,
      'UNDER_REVIEW', body.dateOfBirth || '', body.nationality || '', body.address || '',
      body.employment || '', moneyMinor(body.annualIncome || 0), body.idType || 'NATIONAL_ID',
      body.idNumber || '', body.documentName || profile.document_name || 'uploaded-document.pdf',
      body.documentMime || null, body.documentDataB64 || null, nowIso(), user.id
    );
  } else {
    await execute(
      `INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,document_mime,document_data_b64,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      user.id, 'UNDER_REVIEW', body.dateOfBirth, body.nationality, body.address,
      body.employment, moneyMinor(body.annualIncome || 0), body.idType, body.idNumber,
      body.documentName || 'uploaded-document.pdf', body.documentMime || null,
      body.documentDataB64 || null, nowIso()
    );
  }

  await notify(
    user.id, 'KYC_SUBMITTED', 'Identity verification submitted',
    'Your KYC profile is under review.'
  );
  await audit(user.id, 'SUBMIT_KYC', 'KYC', user.id);

  return send(res, 200, {
    message: 'KYC submitted for review.',
    kyc: sanitizeIdNumber(
      await queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', user.id)
    )
  });
}

// ---------------------------------------------------------- ACCOUNTS

export async function listAccounts(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    'SELECT * FROM accounts WHERE user_id=? ORDER BY id', user.id
  ));
}

export async function openAccount(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const kyc = await queryOne('SELECT status FROM kyc_profiles WHERE user_id=?', user.id);
  if (kyc?.status !== 'VERIFIED') {
    return error(res, 403, 'Verified KYC is required to open an account.');
  }

  const body = await bodyJson(req);
  const type = ACCOUNT_TYPES.includes(body.accountType) ? body.accountType : 'SAVINGS';
  const currency = CURRENCIES.includes(body.currency) ? body.currency : 'EGP';
  const number = uniqueAccountNumber();

  const inserted = await execute(
    `INSERT INTO accounts (user_id,account_number,iban,account_type,currency,balance_minor,available_minor,status,daily_limit_minor,daily_transferred_minor,daily_counter_date,opened_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, number, uniqueIban(number), type, currency, 0, 0, 'ACTIVE',
    currency === 'EGP' ? 25000000 : 500000, 0, nowIso().slice(0, 10), nowIso()
  );

  await audit(user.id, 'OPEN_ACCOUNT', 'ACCOUNT', inserted.lastInsertRowid, 'SUCCESS', {
    type, currency
  });

  return send(res, 201, await queryOne(
    'SELECT * FROM accounts WHERE id=?', inserted.lastInsertRowid
  ));
}

export async function changeAccountState(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const account = await ownAccount(user.id, params[0]);
  if (!account) return error(res, 404, 'Account not found.');

  const action = params[1];

  if (action === 'close' && account.balance_minor !== 0) {
    return error(res, 409, 'Account balance must be zero before closure.');
  }

  const status = action === 'freeze' ? 'FROZEN' : 'CLOSED';

  await execute(
    'UPDATE accounts SET status=?,closed_at=? WHERE id=?',
    status, status === 'CLOSED' ? nowIso() : null, account.id
  );
  await audit(
    user.id, action === 'freeze' ? 'FREEZE_OWN_ACCOUNT' : 'CLOSE_ACCOUNT', 'ACCOUNT', account.id
  );

  return send(res, 200, await queryOne('SELECT * FROM accounts WHERE id=?', account.id));
}

export async function accountTransactions(req, res, params, url) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const account = await ownAccount(user.id, params[0]);
  if (!account) return error(res, 404, 'Account not found.');

  const filters = {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    type: url.searchParams.get('type'),
    status: url.searchParams.get('status'),
    reference: url.searchParams.get('reference'),
    minAmount: url.searchParams.get('minAmount'),
    maxAmount: url.searchParams.get('maxAmount')
  };

  let sql = 'SELECT * FROM transactions WHERE account_id=?';
  const params_ = [account.id];

  if (filters.from) { sql += ' AND created_at>=?'; params_.push(filters.from); }
  if (filters.to) { sql += ' AND created_at<=?'; params_.push(`${filters.to}T23:59:59.999Z`); }
  if (filters.type) { sql += ' AND transaction_type=?'; params_.push(filters.type); }
  if (filters.status) { sql += ' AND status=?'; params_.push(filters.status); }
  if (filters.reference) { sql += ' AND reference LIKE ?'; params_.push(`%${filters.reference}%`); }
  if (filters.minAmount) { sql += ' AND amount_minor>=?'; params_.push(moneyMinor(filters.minAmount)); }
  if (filters.maxAmount) { sql += ' AND amount_minor<=?'; params_.push(moneyMinor(filters.maxAmount)); }

  sql += ' ORDER BY created_at DESC LIMIT 500';

  return send(res, 200, await queryAll(sql, ...params_));
}

export async function accountStatement(req, res, params, url) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const account = await ownAccount(user.id, params[0]);
  if (!account) return error(res, 404, 'Account not found.');

  const from = url.searchParams.get('from') || '1970-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';

  const transactions = await queryAll(
    `SELECT * FROM transactions
      WHERE account_id=? AND created_at>=? AND created_at<=?
      ORDER BY created_at ASC`,
    account.id, from, `${to}T23:59:59.999Z`
  );

  /*
   * The opening balance is derived by reversing the first transaction out of
   * the balance it left behind, so a statement reconciles even when the window
   * starts mid-history.
   */
  const first = transactions[0];
  const opening = first
    ? first.balance_after_minor - (
      first.direction === 'CREDIT'
        ? first.amount_minor
        : -(first.amount_minor + first.fee_minor)
    )
    : account.balance_minor;

  const credits = transactions
    .filter(t => t.direction === 'CREDIT')
    .reduce((sum, t) => sum + t.amount_minor, 0);
  const debits = transactions
    .filter(t => t.direction === 'DEBIT')
    .reduce((sum, t) => sum + t.amount_minor, 0);
  const fees = transactions.reduce((sum, t) => sum + t.fee_minor, 0);

  if (url.searchParams.get('format') === 'csv') {
    const rows = [
      'Date,Reference,Type,Direction,Description,Amount,Fee,Currency,Balance',
      ...transactions.map(t => [
        t.created_at, t.reference, t.transaction_type, t.direction,
        JSON.stringify(t.description), (t.amount_minor / 100).toFixed(2),
        (t.fee_minor / 100).toFixed(2), t.currency,
        (t.balance_after_minor / 100).toFixed(2)
      ].join(','))
    ];

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="statement-${account.account_number}.csv"`,
      'Cache-Control': 'no-store'
    });
    return res.end(rows.join('\n'));
  }

  return send(res, 200, {
    account,
    from,
    to,
    opening_balance_minor: opening,
    credits_minor: credits,
    debits_minor: debits,
    fees_minor: fees,
    closing_balance_minor: opening + credits - debits - fees,
    transactions
  });
}

// ----------------------------------------------------- BENEFICIARIES

/*
 * Deleting a beneficiary retires the row rather than removing it, because
 * historical transfers reference it. Retired rows are therefore excluded here
 * instead of at delete time: a client asking for "my beneficiaries" means the
 * ones it can still pay, and a transfer to a non-ACTIVE beneficiary is refused
 * anyway. Pass ?includeDeleted=true for the full lifecycle. (BUG-BEN-001)
 */
export async function listBeneficiaries(req, res, _params, url) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const includeDeleted = url?.searchParams.get('includeDeleted') === 'true';

  const rows = includeDeleted
    ? await queryAll(
        'SELECT * FROM beneficiaries WHERE user_id=? ORDER BY created_at DESC', user.id
      )
    : await queryAll(
        `SELECT * FROM beneficiaries
          WHERE user_id=? AND status <> 'DELETED'
          ORDER BY created_at DESC`, user.id
      );

  return send(res, 200, rows);
}

export async function addBeneficiary(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  if (!body.name || !body.bankName || !body.accountIdentifier || !body.currency) {
    return error(res, 400, 'name, bankName, accountIdentifier and currency are required.');
  }

  try {
    const inserted = await execute(
      `INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      user.id, body.name, String(body.bankName).toUpperCase(), body.accountIdentifier,
      body.currency, body.nickname || '', 'ACTIVE', 0, nowIso()
    );

    await notify(
      user.id, 'BENEFICIARY_ADDED', 'Beneficiary added',
      `${body.name} was added and requires OTP verification.`
    );
    await audit(user.id, 'ADD_BENEFICIARY', 'BENEFICIARY', inserted.lastInsertRowid);

    return send(res, 201, {
      ...(await queryOne('SELECT * FROM beneficiaries WHERE id=?', inserted.lastInsertRowid)),
      demoOtp: QA_MODE ? BENEFICIARY_OTP : undefined
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return error(res, 409, 'This beneficiary already exists.');
    }
    throw err;
  }
}

export async function verifyBeneficiary(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  const beneficiary = await queryOne(
    'SELECT * FROM beneficiaries WHERE id=? AND user_id=?', Number(params[0]), user.id
  );
  if (!beneficiary) return error(res, 404, 'Beneficiary not found.');

  if (String(body.code) !== BENEFICIARY_OTP) {
    return error(res, 401, 'Invalid verification code.');
  }

  await execute('UPDATE beneficiaries SET verified=1 WHERE id=?', beneficiary.id);
  await audit(user.id, 'VERIFY_BENEFICIARY', 'BENEFICIARY', beneficiary.id);

  return send(res, 200, await queryOne(
    'SELECT * FROM beneficiaries WHERE id=?', beneficiary.id
  ));
}

export async function updateBeneficiary(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  const beneficiary = await queryOne(
    'SELECT * FROM beneficiaries WHERE id=? AND user_id=?', Number(params[0]), user.id
  );
  if (!beneficiary) return error(res, 404, 'Beneficiary not found.');

  await execute(
    'UPDATE beneficiaries SET name=?,nickname=?,status=? WHERE id=?',
    body.name ?? beneficiary.name,
    body.nickname ?? beneficiary.nickname,
    body.status ?? beneficiary.status,
    beneficiary.id
  );
  await audit(user.id, 'UPDATE_BENEFICIARY', 'BENEFICIARY', beneficiary.id);

  return send(res, 200, await queryOne(
    'SELECT * FROM beneficiaries WHERE id=?', beneficiary.id
  ));
}

export async function deleteBeneficiary(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const beneficiary = await queryOne(
    'SELECT * FROM beneficiaries WHERE id=? AND user_id=?', Number(params[0]), user.id
  );
  if (!beneficiary) return error(res, 404, 'Beneficiary not found.');

  /*
   * Soft delete: historical transfers reference this row, so the record is
   * retired rather than removed.
   */
  await execute("UPDATE beneficiaries SET status='DELETED' WHERE id=?", beneficiary.id);
  await audit(user.id, 'DELETE_BENEFICIARY', 'BENEFICIARY', beneficiary.id);

  return send(res, 200, { message: 'Beneficiary deleted.' });
}

// --------------------------------------------------------- TRANSFERS

export async function listTransfers(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    `SELECT t.*, b.name AS beneficiary_name, b.bank_name
       FROM transfers t
       LEFT JOIN beneficiaries b ON b.id = t.beneficiary_id
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC
      LIMIT 300`,
    user.id
  ));
}

export async function createTransfer(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  const result = await executeTransfer({
    userId: user.id,
    fromAccountId: Number(body.fromAccountId),
    beneficiaryId: body.beneficiaryId ? Number(body.beneficiaryId) : null,
    toOwnAccountId: body.toOwnAccountId ? Number(body.toOwnAccountId) : null,
    amountMinor: moneyMinor(body.amount),
    memo: body.memo || '',
    idempotencyKey:
      body.idempotencyKey || req.headers['idempotency-key'] || randomToken(10),
    scheduleFor: body.scheduleFor || null,
    qaSimulation: QA_MODE ? body.qaSimulation : null
  });

  return send(res, result.status === 'FAILED' ? 422 : 201, result);
}

// ------------------------------------------------------------- CARDS

export async function listCards(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    'SELECT * FROM cards WHERE user_id=? ORDER BY id DESC', user.id
  ));
}

export async function requestCard(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);
  const account = await ownAccount(user.id, body.accountId);

  if (!account) return error(res, 404, 'Account not found.');
  if (account.status !== 'ACTIVE') {
    return error(res, 409, 'Card can only be requested for an active account.');
  }

  const inserted = await execute(
    `INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    user.id, account.id, String(Math.floor(1000 + Math.random() * 9000)),
    `${user.first_name} ${user.last_name}`.toUpperCase(), 'DEBIT',
    'PENDING_ACTIVATION', 12, new Date().getFullYear() + 4, nowIso()
  );

  await audit(user.id, 'REQUEST_CARD', 'CARD', inserted.lastInsertRowid);

  return send(res, 201, await queryOne(
    'SELECT * FROM cards WHERE id=?', inserted.lastInsertRowid
  ));
}

export async function cardAction(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const card = await queryOne(
    'SELECT * FROM cards WHERE id=? AND user_id=?', Number(params[0]), user.id
  );
  if (!card) return error(res, 404, 'Card not found.');

  const action = params[1];
  const body = await bodyJson(req);

  if (action === 'activate') {
    await execute("UPDATE cards SET status='ACTIVE' WHERE id=?", card.id);
  } else if (action === 'freeze') {
    await execute("UPDATE cards SET status='FROZEN' WHERE id=?", card.id);
  } else if (action === 'unfreeze') {
    if (card.status !== 'FROZEN') {
      return error(res, 409, 'Only frozen cards can be unfrozen.');
    }
    await execute("UPDATE cards SET status='ACTIVE' WHERE id=?", card.id);
  } else if (action === 'cancel') {
    await execute(
      "UPDATE cards SET status='CANCELLED',cancelled_at=? WHERE id=?", nowIso(), card.id
    );
  } else if (action === 'settings') {
    await execute(
      `UPDATE cards
          SET atm_enabled=?,online_enabled=?,international_enabled=?,contactless_enabled=?,
              atm_limit_minor=?,purchase_limit_minor=?,online_limit_minor=?
        WHERE id=?`,
      body.atmEnabled ? 1 : 0, body.onlineEnabled ? 1 : 0,
      body.internationalEnabled ? 1 : 0, body.contactlessEnabled ? 1 : 0,
      moneyMinor(body.atmLimit ?? card.atm_limit_minor / 100),
      moneyMinor(body.purchaseLimit ?? card.purchase_limit_minor / 100),
      moneyMinor(body.onlineLimit ?? card.online_limit_minor / 100),
      card.id
    );
  } else if (action === 'replace') {
    await execute("UPDATE cards SET status='REPLACED' WHERE id=?", card.id);

    const replacement = await execute(
      `INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      user.id, card.account_id, String(Math.floor(1000 + Math.random() * 9000)),
      card.cardholder_name, card.card_type, 'PENDING_ACTIVATION', 12,
      new Date().getFullYear() + 4, nowIso()
    );

    await execute(
      'UPDATE cards SET replaced_by_card_id=? WHERE id=?',
      replacement.lastInsertRowid, card.id
    );
  }

  await audit(user.id, `${action.toUpperCase()}_CARD`, 'CARD', card.id, 'SUCCESS', body);

  return send(res, 200, await queryAll(
    'SELECT * FROM cards WHERE user_id=? ORDER BY id DESC', user.id
  ));
}

// ------------------------------------------------------------- BILLS

export async function listBillers(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const [billers, saved] = await Promise.all([
    queryAll('SELECT * FROM billers ORDER BY category,name'),
    queryAll(
      `SELECT s.*, b.name, b.category, b.customer_reference_label
         FROM saved_billers s
         JOIN billers b ON b.id = s.biller_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC`,
      user.id
    )
  ]);

  return send(res, 200, { billers, saved });
}

export async function saveBiller(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  try {
    const inserted = await execute(
      `INSERT INTO saved_billers (user_id,biller_id,alias,customer_reference,created_at)
       VALUES (?,?,?,?,?)`,
      user.id, Number(body.billerId), body.alias || '', body.customerReference || '', nowIso()
    );

    await audit(user.id, 'SAVE_BILLER', 'SAVED_BILLER', inserted.lastInsertRowid);

    return send(res, 201, await queryOne(
      'SELECT * FROM saved_billers WHERE id=?', inserted.lastInsertRowid
    ));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return error(res, 409, 'This biller reference is already saved.');
    }
    throw err;
  }
}

export async function listBillPayments(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    `SELECT p.*, b.name AS biller_name, b.category
       FROM bill_payments p
       JOIN billers b ON b.id = p.biller_id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC`,
    user.id
  ));
}

export async function createBillPayment(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  const result = await processBillPayment({
    userId: user.id,
    accountId: Number(body.accountId),
    billerId: Number(body.billerId),
    savedBillerId: body.savedBillerId ? Number(body.savedBillerId) : null,
    customerReference: body.customerReference || '',
    amountMinor: moneyMinor(body.amount),
    scheduledFor: body.scheduleFor || null,
    recurringFrequency: body.recurringFrequency || null
  });

  return send(res, 201, result);
}

// ------------------------------------------------------------- LOANS

export async function listLoans(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    'SELECT * FROM loans WHERE user_id=? ORDER BY applied_at DESC', user.id
  ));
}

export async function applyForLoan(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const kyc = await queryOne('SELECT status FROM kyc_profiles WHERE user_id=?', user.id);
  if (kyc?.status !== 'VERIFIED') {
    return error(res, 403, 'Verified KYC is required to apply for a loan.');
  }

  const body = await bodyJson(req);
  const amount = moneyMinor(body.amount);
  const months = Number(body.termMonths);
  const rate = body.loanType === 'AUTO' ? 15.5 : 18;

  if (!Number.isInteger(amount) || amount < MIN_LOAN_MINOR) {
    return error(res, 400, 'Loan amount must be at least 1,000.');
  }
  if (!LOAN_TERMS.includes(months)) {
    return error(res, 400, `Term must be ${LOAN_TERMS.join(', ')} months.`);
  }

  const account = await ownAccount(user.id, body.disbursementAccountId);
  if (!account) return error(res, 404, 'Disbursement account not found.');

  const monthly = calculateLoanPayment(amount, rate, months);

  const inserted = await execute(
    `INSERT INTO loans (user_id,loan_type,amount_minor,interest_rate,term_months,monthly_payment_minor,remaining_principal_minor,purpose,status,disbursement_account_id,applied_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, body.loanType || 'PERSONAL', amount, rate, months, monthly, amount,
    body.purpose || '', 'SUBMITTED', account.id, nowIso()
  );

  await notify(
    user.id, 'LOAN_SUBMITTED', 'Loan application submitted',
    `Loan #${inserted.lastInsertRowid} is awaiting review.`
  );
  await audit(user.id, 'APPLY_LOAN', 'LOAN', inserted.lastInsertRowid, 'SUCCESS', {
    amount, months, rate
  });

  return send(res, 201, await queryOne(
    'SELECT * FROM loans WHERE id=?', inserted.lastInsertRowid
  ));
}

export async function repayLoan(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = await bodyJson(req);

  return send(res, 200, await payLoan(
    user.id, Number(params[0]), Number(body.accountId), moneyMinor(body.amount)
  ));
}

// ----------------------------------------------------- NOTIFICATIONS

export async function listNotifications(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  return send(res, 200, await queryAll(
    'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200', user.id
  ));
}

export async function markNotificationRead(req, res, params) {
  const user = await requireAuth(req, res);
  if (!user) return;

  await execute(
    'UPDATE notifications SET read_at=? WHERE id=? AND user_id=?',
    nowIso(), Number(params[0]), user.id
  );

  return send(res, 200, { message: 'Notification marked read.' });
}
