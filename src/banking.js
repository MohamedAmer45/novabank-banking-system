import { queryAll, queryOne, execute, withTransaction } from './database.js';
import { nowIso, randomToken } from './security.js';

export const FX = { EGP: 1, USD: 48.5, EUR: 52.4, GBP: 61.1 };

export async function audit(
  actorUserId,
  action,
  entityType,
  entityId,
  result = 'SUCCESS',
  metadata = {},
  ip = '127.0.0.1'
) {
  await execute(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,result,metadata_json,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    actorUserId || null,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    ip,
    result,
    JSON.stringify(metadata || {}),
    nowIso()
  );
}

export async function notify(userId, type, title, message, channel = 'IN_APP') {
  await execute(
    `INSERT INTO notifications (user_id,channel,notification_type,title,message,created_at)
     VALUES (?,?,?,?,?,?)`,
    userId, channel, type, title, message, nowIso()
  );
}

export function publicUser(user) {
  if (!user) return null;
  const { password_hash, mfa_code, ...safe } = user;
  return safe;
}

export async function userSnapshot(userId) {
  const user = publicUser(await queryOne('SELECT * FROM users WHERE id=?', userId));
  if (!user) return null;

  const [kyc, accounts, cards, unread] = await Promise.all([
    queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', userId),
    queryAll('SELECT * FROM accounts WHERE user_id=? ORDER BY id', userId),
    queryAll('SELECT * FROM cards WHERE user_id=? ORDER BY id DESC', userId),
    queryOne(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL',
      userId
    )
  ]);

  return {
    user,
    kyc: kyc || null,
    accounts,
    cards,
    unreadNotifications: Number(unread?.count || 0)
  };
}

export async function resetDailyCounterIfNeeded(account) {
  const today = nowIso().slice(0, 10);
  if (account.daily_counter_date === today) return account;

  await execute(
    'UPDATE accounts SET daily_transferred_minor=0,daily_counter_date=? WHERE id=?',
    today, account.id
  );

  return { ...account, daily_transferred_minor: 0, daily_counter_date: today };
}

function transferRef(prefix = 'TRF') {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${prefix}-${day}-${randomToken(4).toUpperCase()}`;
}

function txnRef() {
  return `TXN-${Date.now()}-${randomToken(3).toUpperCase()}`;
}

/* Exported for unit testing; not part of the module's working surface. */
export function convertMinor(amountMinor, source, target) {
  if (source === target) return { rate: 1, amount: amountMinor };
  const egp = amountMinor * FX[source];
  return { rate: FX[source] / FX[target], amount: Math.round(egp / FX[target]) };
}

/*
 * Locks every account a money movement touches in a single statement, ordered
 * by id. Taking the locks in one deterministic order stops two concurrent
 * transfers between the same pair of accounts from deadlocking by grabbing
 * them in opposite orders. SQLite serialised all writers so this was implicit;
 * on PostgreSQL it has to be explicit, and the concurrency suite depends on it.
 */
async function lockAccounts(...accountIds) {
  const ids = [...new Set(accountIds.filter(id => id != null).map(Number))];
  if (ids.length === 0) return new Map();

  const rows = await queryAll(
    `SELECT * FROM accounts WHERE id = ANY(?) ORDER BY id FOR UPDATE`,
    ids
  );

  return new Map(rows.map(row => [row.id, row]));
}

/*
 * Works out which account the money lands in, and what kind of transfer this
 * is, without taking any locks. Only identity is trusted from these reads;
 * balances and statuses are re-read from the locked rows by the caller.
 */
async function resolveTransferTarget({
  userId, fromAccountId, beneficiaryId, toOwnAccountId
}) {
  const source = await queryOne(
    'SELECT id,currency FROM accounts WHERE id=? AND user_id=?', fromAccountId, userId
  );
  if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });

  if (beneficiaryId) {
    const beneficiary = await queryOne(
      'SELECT * FROM beneficiaries WHERE id=? AND user_id=?', beneficiaryId, userId
    );
    if (!beneficiary) throw Object.assign(new Error('Beneficiary not found.'), { status: 404 });
    if (beneficiary.status !== 'ACTIVE' || !beneficiary.verified) {
      throw Object.assign(new Error('Beneficiary is not active and verified.'), { status: 409 });
    }

    if (beneficiary.bank_name !== 'NOVABANK') {
      return {
        targetAccountId: null,
        beneficiary,
        type: 'EXTERNAL',
        externalCurrency: beneficiary.currency
      };
    }

    const target = await queryOne(
      'SELECT id FROM accounts WHERE account_number=?', beneficiary.account_identifier
    );
    if (!target) {
      throw Object.assign(
        new Error('NovaBank beneficiary account does not exist.'), { status: 404 }
      );
    }

    return {
      targetAccountId: target.id,
      beneficiary,
      type: 'SAME_BANK',
      externalCurrency: null
    };
  }

  if (toOwnAccountId) {
    if (Number(toOwnAccountId) === Number(fromAccountId)) {
      throw Object.assign(
        new Error('Source and destination accounts must be different.'), { status: 400 }
      );
    }

    const target = await queryOne(
      'SELECT id FROM accounts WHERE id=? AND user_id=?', toOwnAccountId, userId
    );
    if (!target) throw Object.assign(new Error('Destination account not found.'), { status: 404 });

    return {
      targetAccountId: target.id,
      beneficiary: null,
      type: 'OWN_ACCOUNT',
      externalCurrency: null
    };
  }

  throw Object.assign(
    new Error('A destination account or beneficiary is required.'), { status: 400 }
  );
}

async function createTransaction({
  accountId, transferId = null, billPaymentId = null, loanId = null,
  type, direction, amountMinor, feeMinor = 0, currency, description, balanceAfterMinor
}) {
  await execute(
    `INSERT INTO transactions (reference,account_id,transfer_id,bill_payment_id,loan_id,transaction_type,direction,amount_minor,fee_minor,currency,status,description,balance_after_minor,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    txnRef(), accountId, transferId, billPaymentId, loanId, type, direction,
    amountMinor, feeMinor, currency, 'COMPLETED', description, balanceAfterMinor, nowIso()
  );
}

async function addFraudAlert(userId, transferId, ruleCode, severity, description) {
  await execute(
    `INSERT INTO fraud_alerts (user_id,transfer_id,rule_code,severity,status,description,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    userId, transferId, ruleCode, severity, 'OPEN', description, nowIso()
  );
}

export async function executeTransfer({
  userId, fromAccountId, beneficiaryId, toOwnAccountId, amountMinor,
  memo = '', idempotencyKey, scheduleFor = null, qaSimulation = null
}) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw Object.assign(new Error('Transfer amount must be greater than zero.'), { status: 400 });
  }

  if (!idempotencyKey) idempotencyKey = randomToken(12);

  const existing = await queryOne(
    'SELECT * FROM transfers WHERE user_id=? AND idempotency_key=?',
    userId, idempotencyKey
  );
  if (existing) return existing;

  if (scheduleFor && new Date(scheduleFor).getTime() > Date.now() + 30000) {
    return scheduleTransfer({
      userId, fromAccountId, beneficiaryId, toOwnAccountId,
      amountMinor, memo, idempotencyKey, scheduleFor
    });
  }

  return withTransaction(async () => {
    /*
     * Resolve which accounts are involved before taking any lock, then acquire
     * every lock in one id-ordered statement. Locking source-then-target would
     * let two reciprocal transfers (A->B and B->A) grab the same pair in
     * opposite orders and deadlock. Nothing is validated against these
     * unlocked reads: identity is stable, but balance and status are re-read
     * from the locked rows below.
     */
    const resolution = await resolveTransferTarget({
      userId, fromAccountId, beneficiaryId, toOwnAccountId
    });

    const { beneficiary, type, externalCurrency } = resolution;

    const locked = await lockAccounts(fromAccountId, resolution.targetAccountId);

    let source = locked.get(Number(fromAccountId));
    if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });

    source = await resetDailyCounterIfNeeded(source);
    if (source.status !== 'ACTIVE') {
      throw Object.assign(new Error(`Source account is ${source.status}.`), { status: 409 });
    }

    const target = resolution.targetAccountId
      ? locked.get(Number(resolution.targetAccountId))
      : null;

    if (resolution.targetAccountId && !target) {
      throw Object.assign(new Error('Destination account not found.'), { status: 404 });
    }
    if (target && target.status !== 'ACTIVE') {
      throw Object.assign(new Error(`Destination account is ${target.status}.`), { status: 409 });
    }

    const targetCurrency = target ? target.currency : (externalCurrency ?? source.currency);

    const fee = type === 'EXTERNAL' ? Math.max(500, Math.round(amountMinor * 0.001)) : 0;
    const totalDebit = amountMinor + fee;

    if (source.available_minor < totalDebit) {
      throw Object.assign(new Error('Insufficient available balance.'), { status: 409 });
    }
    if (source.daily_transferred_minor + amountMinor > source.daily_limit_minor) {
      throw Object.assign(new Error('Daily transfer limit exceeded.'), { status: 409 });
    }

    const conv = convertMinor(amountMinor, source.currency, targetCurrency);
    const ref = transferRef();

    const inserted = await execute(
      `INSERT INTO transfers (reference,user_id,from_account_id,beneficiary_id,to_account_id,transfer_type,source_currency,target_currency,fx_rate,amount_minor,credited_amount_minor,fee_minor,status,memo,idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, userId, source.id, beneficiaryId || null, target?.id || null, type,
      source.currency, targetCurrency, conv.rate, amountMinor, conv.amount, fee,
      'PROCESSING', memo, idempotencyKey, nowIso()
    );
    const transferId = inserted.lastInsertRowid;

    if (qaSimulation === 'failure' || beneficiary?.bank_name === 'FAILBANK') {
      return failTransfer({ userId, transferId, ref });
    }

    const newSourceBalance = source.balance_minor - totalDebit;
    await execute(
      `UPDATE accounts SET balance_minor=?,available_minor=?,daily_transferred_minor=daily_transferred_minor+?
       WHERE id=?`,
      newSourceBalance, newSourceBalance, amountMinor, source.id
    );
    await createTransaction({
      accountId: source.id, transferId, type: 'TRANSFER', direction: 'DEBIT',
      amountMinor, feeMinor: fee, currency: source.currency,
      description: `Transfer ${ref}${memo ? ` • ${memo}` : ''}`,
      balanceAfterMinor: newSourceBalance
    });

    if (target) {
      const newTargetBalance = target.balance_minor + conv.amount;
      await execute(
        'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',
        newTargetBalance, newTargetBalance, target.id
      );
      await createTransaction({
        accountId: target.id, transferId, type: 'TRANSFER', direction: 'CREDIT',
        amountMinor: conv.amount, currency: target.currency,
        description: `Incoming transfer ${ref}`, balanceAfterMinor: newTargetBalance
      });
      await notify(
        target.user_id, 'TRANSFER_RECEIVED', 'Money received',
        `You received ${conv.amount / 100} ${target.currency} via ${ref}.`
      );
    }

    await execute(
      'UPDATE transfers SET status=?,completed_at=? WHERE id=?',
      'COMPLETED', nowIso(), transferId
    );

    await evaluateFraudRules({ userId, transferId, amountMinor, currency: source.currency });

    await notify(userId, 'TRANSFER_COMPLETED', 'Transfer completed', `${ref} completed successfully.`);
    await audit(userId, 'TRANSFER', 'TRANSFER', ref, 'SUCCESS', {
      type, amountMinor, fee, targetCurrency, creditedAmountMinor: conv.amount
    });

    return queryOne('SELECT * FROM transfers WHERE id=?', transferId);
  });
}

async function scheduleTransfer({
  userId, fromAccountId, beneficiaryId, toOwnAccountId,
  amountMinor, memo, idempotencyKey, scheduleFor
}) {
  const source = await queryOne(
    'SELECT * FROM accounts WHERE id=? AND user_id=?', fromAccountId, userId
  );
  if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });

  let targetCurrency = source.currency;
  let transferType = 'OWN_ACCOUNT';

  if (beneficiaryId) {
    const beneficiary = await queryOne(
      'SELECT * FROM beneficiaries WHERE id=? AND user_id=?', beneficiaryId, userId
    );
    if (!beneficiary) throw Object.assign(new Error('Beneficiary not found.'), { status: 404 });
    targetCurrency = beneficiary.currency;
    transferType = beneficiary.bank_name === 'NOVABANK' ? 'SAME_BANK' : 'EXTERNAL';
  } else if (toOwnAccountId) {
    const target = await queryOne(
      'SELECT * FROM accounts WHERE id=? AND user_id=?', toOwnAccountId, userId
    );
    if (!target) throw Object.assign(new Error('Destination account not found.'), { status: 404 });
    targetCurrency = target.currency;
  }

  const conv = convertMinor(amountMinor, source.currency, targetCurrency);
  const ref = transferRef('SCH');

  await execute(
    `INSERT INTO transfers (reference,user_id,from_account_id,beneficiary_id,to_account_id,transfer_type,source_currency,target_currency,fx_rate,amount_minor,credited_amount_minor,fee_minor,status,memo,idempotency_key,scheduled_for,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ref, userId, fromAccountId, beneficiaryId || null, toOwnAccountId || null, transferType,
    source.currency, targetCurrency, conv.rate, amountMinor, conv.amount, 0,
    'PENDING', memo, idempotencyKey, scheduleFor, nowIso()
  );

  await notify(
    userId, 'TRANSFER_SCHEDULED', 'Transfer scheduled',
    `${ref} is scheduled for ${new Date(scheduleFor).toLocaleString()}.`
  );
  await audit(userId, 'SCHEDULE_TRANSFER', 'TRANSFER', ref, 'SUCCESS', { amountMinor, scheduleFor });

  return queryOne('SELECT * FROM transfers WHERE reference=?', ref);
}

async function failTransfer({ userId, transferId, ref }) {
  await execute(
    'UPDATE transfers SET status=?,failure_reason=? WHERE id=?',
    'FAILED', 'Simulated external network rejection', transferId
  );

  const failedSince = new Date(Date.now() - 5 * 60000).toISOString();
  const recentFailures = Number(
    (await queryOne(
      `SELECT COUNT(*) AS count FROM transfers WHERE user_id=? AND status='FAILED' AND created_at>=?`,
      userId, failedSince
    ))?.count || 0
  );

  if (recentFailures >= 3) {
    await addFraudAlert(
      userId, transferId, 'REPEATED_FAILED_TRANSFER', 'MEDIUM',
      'Three or more transfer failures occurred within five minutes.'
    );
  }

  await notify(userId, 'TRANSFER_FAILED', 'Transfer failed', `${ref} failed. No funds were deducted.`);
  await audit(userId, 'TRANSFER', 'TRANSFER', ref, 'FAILED', { reason: 'simulated failure' });

  return queryOne('SELECT * FROM transfers WHERE id=?', transferId);
}

async function evaluateFraudRules({ userId, transferId, amountMinor, currency }) {
  const egpEquivalentMinor = Math.round(amountMinor * FX[currency]);

  if (egpEquivalentMinor >= 10000000) {
    await addFraudAlert(
      userId, transferId, 'LARGE_TRANSFER', 'HIGH',
      'Transfer amount reached the configured 100,000 EGP-equivalent alert threshold.'
    );
  }

  const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
  const burst = Number(
    (await queryOne(
      `SELECT COUNT(*) AS count FROM transfers WHERE user_id=? AND created_at>=?`,
      userId, oneMinuteAgo
    ))?.count || 0
  );

  if (burst >= 5) {
    await addFraudAlert(
      userId, transferId, 'TRANSFER_VELOCITY', 'HIGH',
      'Five or more transfers were attempted within one minute.'
    );
  }
}

export async function reverseTransfer(actorId, transferId) {
  return withTransaction(async () => {
    const transfer = await queryOne('SELECT * FROM transfers WHERE id=?', transferId);
    if (!transfer) throw Object.assign(new Error('Transfer not found.'), { status: 404 });
    if (transfer.status !== 'COMPLETED' || transfer.reversed_at) {
      throw Object.assign(
        new Error('Only completed, unreversed transfers can be reversed.'), { status: 409 }
      );
    }

    const locked = await lockAccounts(transfer.from_account_id, transfer.to_account_id);
    const source = locked.get(Number(transfer.from_account_id));
    const target = transfer.to_account_id ? locked.get(Number(transfer.to_account_id)) : null;

    if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });
    if (target && target.available_minor < transfer.credited_amount_minor) {
      throw Object.assign(
        new Error('Destination has insufficient funds for reversal.'), { status: 409 }
      );
    }

    const restored = source.balance_minor + transfer.amount_minor + transfer.fee_minor;
    await execute(
      'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',
      restored, restored, source.id
    );
    await createTransaction({
      accountId: source.id, transferId: transfer.id, type: 'REVERSAL', direction: 'CREDIT',
      amountMinor: transfer.amount_minor + transfer.fee_minor, currency: source.currency,
      description: `Reversal of ${transfer.reference}`, balanceAfterMinor: restored
    });

    if (target) {
      const reduced = target.balance_minor - transfer.credited_amount_minor;
      await execute(
        'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',
        reduced, reduced, target.id
      );
      await createTransaction({
        accountId: target.id, transferId: transfer.id, type: 'REVERSAL', direction: 'DEBIT',
        amountMinor: transfer.credited_amount_minor, currency: target.currency,
        description: `Reversal of ${transfer.reference}`, balanceAfterMinor: reduced
      });
    }

    await execute(
      'UPDATE transfers SET status=?,reversed_at=? WHERE id=?', 'REVERSED', nowIso(), transfer.id
    );
    await notify(
      transfer.user_id, 'TRANSFER_REVERSED', 'Transfer reversed',
      `${transfer.reference} was reversed by bank operations.`
    );
    await audit(actorId, 'REVERSE_TRANSFER', 'TRANSFER', transfer.reference, 'SUCCESS', {});

    return queryOne('SELECT * FROM transfers WHERE id=?', transfer.id);
  });
}

/* Exported for unit testing; not part of the module's working surface. */
export function nextRecurringDate(frequency) {
  const date = new Date();
  if (frequency === 'WEEKLY') date.setUTCDate(date.getUTCDate() + 7);
  else if (frequency === 'MONTHLY') date.setUTCMonth(date.getUTCMonth() + 1);
  else return null;
  return date.toISOString();
}

export async function processBillPayment({
  userId, accountId, billerId, savedBillerId = null, customerReference,
  amountMinor, scheduledFor = null, recurringFrequency = null
}) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw Object.assign(new Error('Payment amount must be greater than zero.'), { status: 400 });
  }

  const [account, biller] = await Promise.all([
    queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?', accountId, userId),
    queryOne('SELECT * FROM billers WHERE id=?', billerId)
  ]);
  if (!account || !biller) {
    throw Object.assign(new Error('Account or biller not found.'), { status: 404 });
  }

  const ref = transferRef('BILL');

  if (scheduledFor && new Date(scheduledFor).getTime() > Date.now() + 30000) {
    await execute(
      `INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,scheduled_for,recurring_frequency,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ref, userId, accountId, billerId, savedBillerId, customerReference,
      amountMinor, 'SCHEDULED', scheduledFor, recurringFrequency, nowIso()
    );
    await notify(
      userId, 'BILL_SCHEDULED', 'Bill payment scheduled',
      `${biller.name} payment ${ref} is scheduled.`
    );
    await audit(userId, 'SCHEDULE_BILL_PAYMENT', 'BILL_PAYMENT', ref, 'SUCCESS', {
      amountMinor, scheduledFor
    });
    return queryOne('SELECT * FROM bill_payments WHERE reference=?', ref);
  }

  return withTransaction(async () => {
    const fresh = await queryOne('SELECT * FROM accounts WHERE id=? FOR UPDATE', accountId);
    if (fresh.status !== 'ACTIVE') {
      throw Object.assign(new Error(`Account is ${fresh.status}.`), { status: 409 });
    }
    if (fresh.available_minor < amountMinor) {
      throw Object.assign(new Error('Insufficient balance.'), { status: 409 });
    }

    const inserted = await execute(
      `INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,recurring_frequency,created_at,processed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ref, userId, accountId, billerId, savedBillerId, customerReference,
      amountMinor, 'COMPLETED', recurringFrequency, nowIso(), nowIso()
    );
    const paymentId = inserted.lastInsertRowid;

    const balance = fresh.balance_minor - amountMinor;
    await execute(
      'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?', balance, balance, accountId
    );
    await createTransaction({
      accountId, billPaymentId: paymentId, type: 'BILL_PAYMENT', direction: 'DEBIT',
      amountMinor, currency: fresh.currency,
      description: `${biller.name} • ${customerReference}`, balanceAfterMinor: balance
    });
    await notify(userId, 'BILL_PAID', 'Bill paid', `${biller.name} payment ${ref} completed.`);

    if (recurringFrequency) {
      const next = nextRecurringDate(recurringFrequency);
      if (next) {
        await execute(
          `INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,scheduled_for,recurring_frequency,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          transferRef('BILL'), userId, accountId, billerId, savedBillerId, customerReference,
          amountMinor, 'SCHEDULED', next, recurringFrequency, nowIso()
        );
      }
    }

    await audit(userId, 'PAY_BILL', 'BILL_PAYMENT', ref, 'SUCCESS', {
      biller: biller.code, amountMinor, recurringFrequency
    });

    return queryOne('SELECT * FROM bill_payments WHERE id=?', paymentId);
  });
}

export async function processDueScheduledItems() {
  const now = nowIso();

  const dueTransfers = await queryAll(
    `SELECT * FROM transfers WHERE status='PENDING' AND scheduled_for IS NOT NULL AND scheduled_for<=?`,
    now
  );

  for (const transfer of dueTransfers) {
    await execute('UPDATE transfers SET status=? WHERE id=?', 'CANCELLED', transfer.id);
    try {
      await executeTransfer({
        userId: transfer.user_id,
        fromAccountId: transfer.from_account_id,
        beneficiaryId: transfer.beneficiary_id,
        toOwnAccountId: transfer.to_account_id,
        amountMinor: transfer.amount_minor,
        memo: transfer.memo,
        idempotencyKey: `scheduled-${transfer.id}`
      });
    } catch (error) {
      await notify(
        transfer.user_id, 'TRANSFER_FAILED', 'Scheduled transfer failed',
        `${transfer.reference}: ${error.message}`
      );
    }
  }

  const dueBills = await queryAll(
    `SELECT * FROM bill_payments WHERE status='SCHEDULED' AND scheduled_for<=?`, now
  );

  for (const payment of dueBills) {
    await execute('UPDATE bill_payments SET status=? WHERE id=?', 'PROCESSING', payment.id);
    try {
      await processBillPayment({
        userId: payment.user_id,
        accountId: payment.account_id,
        billerId: payment.biller_id,
        savedBillerId: payment.saved_biller_id,
        customerReference: payment.customer_reference,
        amountMinor: payment.amount_minor,
        recurringFrequency: payment.recurring_frequency
      });
      await execute(
        'UPDATE bill_payments SET status=?,processed_at=? WHERE id=?',
        'COMPLETED', nowIso(), payment.id
      );
    } catch (error) {
      await execute(
        'UPDATE bill_payments SET status=?,failure_reason=? WHERE id=?',
        'FAILED', error.message, payment.id
      );
    }
  }
}

export function calculateLoanPayment(amountMinor, annualRatePercent, months) {
  const rate = annualRatePercent / 100 / 12;
  if (rate === 0) return Math.round(amountMinor / months);
  return Math.round(amountMinor * rate * (1 + rate) ** months / ((1 + rate) ** months - 1));
}

export async function reviewLoan(actorId, loanId, decision, note = '') {
  return withTransaction(async () => {
    const loan = await queryOne('SELECT * FROM loans WHERE id=? FOR UPDATE', loanId);
    if (!loan) throw Object.assign(new Error('Loan not found.'), { status: 404 });
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(loan.status)) {
      throw Object.assign(new Error('Loan is not awaiting review.'), { status: 409 });
    }

    if (decision === 'REJECTED') {
      await execute(
        'UPDATE loans SET status=?,reviewed_at=?,reviewer_id=?,review_note=? WHERE id=?',
        'REJECTED', nowIso(), actorId, note, loanId
      );
      await notify(
        loan.user_id, 'LOAN_REJECTED', 'Loan application update',
        `Your ${loan.loan_type.toLowerCase()} loan application was not approved.`
      );
    } else if (decision === 'APPROVED') {
      const account = await queryOne(
        'SELECT * FROM accounts WHERE id=? AND user_id=? FOR UPDATE',
        loan.disbursement_account_id, loan.user_id
      );
      if (!account || account.status !== 'ACTIVE') {
        throw Object.assign(new Error('Disbursement account is not active.'), { status: 409 });
      }

      const balance = account.balance_minor + loan.amount_minor;
      await execute(
        'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',
        balance, balance, account.id
      );
      await execute(
        'UPDATE loans SET status=?,reviewed_at=?,reviewer_id=?,review_note=? WHERE id=?',
        'ACTIVE', nowIso(), actorId, note, loanId
      );
      await createTransaction({
        accountId: account.id, loanId, type: 'LOAN_DISBURSEMENT', direction: 'CREDIT',
        amountMinor: loan.amount_minor, currency: account.currency,
        description: `${loan.loan_type} loan disbursement`, balanceAfterMinor: balance
      });
      await notify(
        loan.user_id, 'LOAN_APPROVED', 'Loan approved',
        `Your loan was approved and disbursed to account ending ${account.account_number.slice(-4)}.`
      );
    } else {
      throw Object.assign(new Error('Decision must be APPROVED or REJECTED.'), { status: 400 });
    }

    await audit(actorId, 'REVIEW_LOAN', 'LOAN', loanId, 'SUCCESS', { decision, note });
    return queryOne('SELECT * FROM loans WHERE id=?', loanId);
  });
}

export async function payLoan(userId, loanId, accountId, amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw Object.assign(new Error('Payment amount must be greater than zero.'), { status: 400 });
  }

  return withTransaction(async () => {
    const loan = await queryOne(
      'SELECT * FROM loans WHERE id=? AND user_id=? FOR UPDATE', loanId, userId
    );
    const account = await queryOne(
      'SELECT * FROM accounts WHERE id=? AND user_id=? FOR UPDATE', accountId, userId
    );

    if (!loan || !account) {
      throw Object.assign(new Error('Loan or account not found.'), { status: 404 });
    }
    if (loan.status !== 'ACTIVE') {
      throw Object.assign(new Error('Loan is not active.'), { status: 409 });
    }
    if (account.status !== 'ACTIVE' || account.available_minor < amountMinor) {
      throw Object.assign(new Error('Account cannot fund this payment.'), { status: 409 });
    }

    const principal = Math.min(loan.remaining_principal_minor, Math.round(amountMinor * 0.85));
    const interest = amountMinor - principal;
    const balance = account.balance_minor - amountMinor;
    const remaining = Math.max(0, loan.remaining_principal_minor - principal);

    await execute(
      'UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',
      balance, balance, account.id
    );
    await execute(
      'UPDATE loans SET remaining_principal_minor=?,status=? WHERE id=?',
      remaining, remaining === 0 ? 'PAID' : 'ACTIVE', loan.id
    );
    await execute(
      `INSERT INTO loan_payments (loan_id,account_id,amount_minor,principal_minor,interest_minor,status,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      loan.id, account.id, amountMinor, principal, interest, 'COMPLETED', nowIso()
    );
    await createTransaction({
      accountId: account.id, loanId: loan.id, type: 'LOAN_PAYMENT', direction: 'DEBIT',
      amountMinor, currency: account.currency,
      description: `Loan #${loan.id} repayment`, balanceAfterMinor: balance
    });
    await notify(
      userId, 'LOAN_PAYMENT', 'Loan payment received',
      `Payment of ${(amountMinor / 100).toFixed(2)} ${account.currency} was applied to loan #${loan.id}.`
    );
    await audit(userId, 'PAY_LOAN', 'LOAN', loan.id, 'SUCCESS', {
      amountMinor, principal, interest
    });

    return queryOne('SELECT * FROM loans WHERE id=?', loan.id);
  });
}
