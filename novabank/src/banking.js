import { db, queryAll, queryOne, execute, withTransaction } from './database.js';
import { nowIso, randomToken } from './security.js';

export const FX = { EGP: 1, USD: 48.5, EUR: 52.4, GBP: 61.1 };

export function audit(actorUserId, action, entityType, entityId, result = 'SUCCESS', metadata = {}, ip = '127.0.0.1') {
  execute(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,result,metadata_json,created_at)
           VALUES (?,?,?,?,?,?,?,?)`, actorUserId || null, action, entityType, entityId == null ? null : String(entityId), ip, result, JSON.stringify(metadata || {}), nowIso());
}

export function notify(userId, type, title, message, channel = 'IN_APP') {
  execute(`INSERT INTO notifications (user_id,channel,notification_type,title,message,created_at) VALUES (?,?,?,?,?,?)`,
    userId, channel, type, title, message, nowIso());
}

export function publicUser(user) {
  if (!user) return null;
  const { password_hash, mfa_code, ...safe } = user;
  return safe;
}

export function userSnapshot(userId) {
  const user = publicUser(queryOne('SELECT * FROM users WHERE id=?', userId));
  if (!user) return null;
  const kyc = queryOne('SELECT * FROM kyc_profiles WHERE user_id=?', userId) || null;
  const accounts = queryAll('SELECT * FROM accounts WHERE user_id=? ORDER BY id', userId);
  const cards = queryAll('SELECT * FROM cards WHERE user_id=? ORDER BY id DESC', userId);
  const unread = queryOne('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL', userId)?.count || 0;
  return { user, kyc, accounts, cards, unreadNotifications: Number(unread) };
}

export function resetDailyCounterIfNeeded(account) {
  const today = nowIso().slice(0, 10);
  if (account.daily_counter_date !== today) {
    execute('UPDATE accounts SET daily_transferred_minor=0,daily_counter_date=? WHERE id=?', today, account.id);
    return { ...account, daily_transferred_minor: 0, daily_counter_date: today };
  }
  return account;
}

function transferRef(prefix = 'TRF') {
  return `${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomToken(4).toUpperCase()}`;
}
function txnRef() { return `TXN-${Date.now()}-${randomToken(3).toUpperCase()}`; }

function convertMinor(amountMinor, source, target) {
  if (source === target) return { rate: 1, amount: amountMinor };
  const egp = amountMinor * FX[source];
  const converted = Math.round(egp / FX[target]);
  return { rate: FX[source] / FX[target], amount: converted };
}

function createTransaction({accountId, transferId=null, billPaymentId=null, loanId=null, type, direction, amountMinor, feeMinor=0, currency, description, balanceAfterMinor}) {
  execute(`INSERT INTO transactions (reference,account_id,transfer_id,bill_payment_id,loan_id,transaction_type,direction,amount_minor,fee_minor,currency,status,description,balance_after_minor,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, txnRef(), accountId, transferId, billPaymentId, loanId, type, direction, amountMinor, feeMinor, currency, 'COMPLETED', description, balanceAfterMinor, nowIso());
}

function addFraudAlert(userId, transferId, ruleCode, severity, description) {
  execute(`INSERT INTO fraud_alerts (user_id,transfer_id,rule_code,severity,status,description,created_at) VALUES (?,?,?,?,?,?,?)`,
    userId, transferId, ruleCode, severity, 'OPEN', description, nowIso());
}

export function executeTransfer({ userId, fromAccountId, beneficiaryId, toOwnAccountId, amountMinor, memo='', idempotencyKey, scheduleFor=null, qaSimulation=null }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw Object.assign(new Error('Transfer amount must be greater than zero.'), { status: 400 });
  if (!idempotencyKey) idempotencyKey = randomToken(12);

  const existing = queryOne('SELECT * FROM transfers WHERE user_id=? AND idempotency_key=?', userId, idempotencyKey);
  if (existing) return existing;

  if (scheduleFor && new Date(scheduleFor).getTime() > Date.now() + 30000) {
    const source = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?', fromAccountId, userId);
    if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });
    let targetCurrency = source.currency;
    let transferType = 'OWN_ACCOUNT';
    let beneficiary = null;
    if (beneficiaryId) {
      beneficiary = queryOne('SELECT * FROM beneficiaries WHERE id=? AND user_id=?', beneficiaryId, userId);
      if (!beneficiary) throw Object.assign(new Error('Beneficiary not found.'), { status: 404 });
      targetCurrency = beneficiary.currency;
      transferType = beneficiary.bank_name === 'NOVABANK' ? 'SAME_BANK' : 'EXTERNAL';
    } else if (toOwnAccountId) {
      const target = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?', toOwnAccountId, userId);
      if (!target) throw Object.assign(new Error('Destination account not found.'), { status: 404 });
      targetCurrency = target.currency;
    }
    const conv = convertMinor(amountMinor, source.currency, targetCurrency);
    const ref = transferRef('SCH');
    execute(`INSERT INTO transfers (reference,user_id,from_account_id,beneficiary_id,to_account_id,transfer_type,source_currency,target_currency,fx_rate,amount_minor,credited_amount_minor,fee_minor,status,memo,idempotency_key,scheduled_for,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref,userId,fromAccountId,beneficiaryId||null,toOwnAccountId||null,transferType,source.currency,targetCurrency,conv.rate,amountMinor,conv.amount,0,'PENDING',memo,idempotencyKey,scheduleFor,nowIso());
    notify(userId,'TRANSFER_SCHEDULED','Transfer scheduled',`${ref} is scheduled for ${new Date(scheduleFor).toLocaleString()}.`);
    audit(userId,'SCHEDULE_TRANSFER','TRANSFER',ref,'SUCCESS',{amountMinor,scheduleFor});
    return queryOne('SELECT * FROM transfers WHERE reference=?', ref);
  }

  return withTransaction(() => {
    let source = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?', fromAccountId, userId);
    if (!source) throw Object.assign(new Error('Source account not found.'), { status: 404 });
    source = resetDailyCounterIfNeeded(source);
    if (source.status !== 'ACTIVE') throw Object.assign(new Error(`Source account is ${source.status}.`), { status: 409 });

    let target = null, beneficiary = null, type = 'OWN_ACCOUNT', targetCurrency = source.currency;
    if (beneficiaryId) {
      beneficiary = queryOne('SELECT * FROM beneficiaries WHERE id=? AND user_id=?', beneficiaryId, userId);
      if (!beneficiary) throw Object.assign(new Error('Beneficiary not found.'), { status: 404 });
      if (beneficiary.status !== 'ACTIVE' || !beneficiary.verified) throw Object.assign(new Error('Beneficiary is not active and verified.'), { status: 409 });
      if (beneficiary.bank_name === 'NOVABANK') {
        target = queryOne('SELECT * FROM accounts WHERE account_number=?', beneficiary.account_identifier);
        if (!target) throw Object.assign(new Error('NovaBank beneficiary account does not exist.'), { status: 404 });
        if (target.status !== 'ACTIVE') throw Object.assign(new Error(`Destination account is ${target.status}.`), { status: 409 });
        type = 'SAME_BANK';
        targetCurrency = target.currency;
      } else {
        type = 'EXTERNAL';
        targetCurrency = beneficiary.currency;
      }
    } else if (toOwnAccountId) {
      target = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?', toOwnAccountId, userId);
      if (!target) throw Object.assign(new Error('Destination account not found.'), { status: 404 });
      if (target.id === source.id) throw Object.assign(new Error('Source and destination accounts must be different.'), { status: 400 });
      if (target.status !== 'ACTIVE') throw Object.assign(new Error(`Destination account is ${target.status}.`), { status: 409 });
      targetCurrency = target.currency;
    } else {
      throw Object.assign(new Error('A destination account or beneficiary is required.'), { status: 400 });
    }

    const fee = type === 'EXTERNAL' ? Math.max(500, Math.round(amountMinor * 0.001)) : 0;
    const totalDebit = amountMinor + fee;
    if (source.available_minor < totalDebit) throw Object.assign(new Error('Insufficient available balance.'), { status: 409 });
    if (source.daily_transferred_minor + amountMinor > source.daily_limit_minor) throw Object.assign(new Error('Daily transfer limit exceeded.'), { status: 409 });

    const conv = convertMinor(amountMinor, source.currency, targetCurrency);
    const ref = transferRef();
    execute(`INSERT INTO transfers (reference,user_id,from_account_id,beneficiary_id,to_account_id,transfer_type,source_currency,target_currency,fx_rate,amount_minor,credited_amount_minor,fee_minor,status,memo,idempotency_key,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref,userId,source.id,beneficiaryId||null,target?.id||null,type,source.currency,targetCurrency,conv.rate,amountMinor,conv.amount,fee,'PROCESSING',memo,idempotencyKey,nowIso());
    const transferId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

    if (qaSimulation === 'failure' || beneficiary?.bank_name === 'FAILBANK') {
      execute('UPDATE transfers SET status=?,failure_reason=? WHERE id=?','FAILED','Simulated external network rejection',transferId);
      const failedSince = new Date(Date.now()-5*60000).toISOString();
      const recentFailures = Number(queryOne(`SELECT COUNT(*) AS count FROM transfers WHERE user_id=? AND status='FAILED' AND created_at>=?`,userId,failedSince)?.count || 0);
      if (recentFailures >= 3) addFraudAlert(userId, transferId, 'REPEATED_FAILED_TRANSFER', 'MEDIUM', 'Three or more transfer failures occurred within five minutes.');
      notify(userId,'TRANSFER_FAILED','Transfer failed',`${ref} failed. No funds were deducted.`);
      audit(userId,'TRANSFER','TRANSFER',ref,'FAILED',{reason:'simulated failure'});
      return queryOne('SELECT * FROM transfers WHERE id=?', transferId);
    }

    const newSourceBalance = source.balance_minor - totalDebit;
    execute(`UPDATE accounts SET balance_minor=?,available_minor=?,daily_transferred_minor=daily_transferred_minor+? WHERE id=?`,
      newSourceBalance,newSourceBalance,amountMinor,source.id);
    createTransaction({accountId:source.id,transferId,type:'TRANSFER',direction:'DEBIT',amountMinor,feeMinor:fee,currency:source.currency,description:`Transfer ${ref}${memo ? ` • ${memo}` : ''}`,balanceAfterMinor:newSourceBalance});

    if (target) {
      const newTargetBalance = target.balance_minor + conv.amount;
      execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',newTargetBalance,newTargetBalance,target.id);
      createTransaction({accountId:target.id,transferId,type:'TRANSFER',direction:'CREDIT',amountMinor:conv.amount,currency:target.currency,description:`Incoming transfer ${ref}`,balanceAfterMinor:newTargetBalance});
      notify(target.user_id,'TRANSFER_RECEIVED','Money received',`You received ${conv.amount / 100} ${target.currency} via ${ref}.`);
    }

    execute('UPDATE transfers SET status=?,completed_at=? WHERE id=?','COMPLETED',nowIso(),transferId);

    const egpEquivalentMinor = Math.round(amountMinor * FX[source.currency]);
    if (egpEquivalentMinor >= 10000000) addFraudAlert(userId, transferId, 'LARGE_TRANSFER', 'HIGH', 'Transfer amount reached the configured 100,000 EGP-equivalent alert threshold.');
    const oneMinuteAgo = new Date(Date.now()-60000).toISOString();
    const burst = Number(queryOne(`SELECT COUNT(*) AS count FROM transfers WHERE user_id=? AND created_at>=?`,userId,oneMinuteAgo)?.count || 0);
    if (burst >= 5) addFraudAlert(userId, transferId, 'TRANSFER_VELOCITY', 'HIGH', 'Five or more transfers were attempted within one minute.');

    notify(userId,'TRANSFER_COMPLETED','Transfer completed',`${ref} completed successfully.`);
    audit(userId,'TRANSFER','TRANSFER',ref,'SUCCESS',{type,amountMinor,fee,targetCurrency,creditedAmountMinor:conv.amount});
    return queryOne('SELECT * FROM transfers WHERE id=?', transferId);
  });
}

export function reverseTransfer(actorId, transferId) {
  return withTransaction(() => {
    const t = queryOne('SELECT * FROM transfers WHERE id=?', transferId);
    if (!t) throw Object.assign(new Error('Transfer not found.'), {status:404});
    if (t.status !== 'COMPLETED' || t.reversed_at) throw Object.assign(new Error('Only completed, unreversed transfers can be reversed.'), {status:409});
    const source = queryOne('SELECT * FROM accounts WHERE id=?', t.from_account_id);
    const target = t.to_account_id ? queryOne('SELECT * FROM accounts WHERE id=?', t.to_account_id) : null;
    if (target && target.available_minor < t.credited_amount_minor) throw Object.assign(new Error('Destination has insufficient funds for reversal.'), {status:409});

    const restored = source.balance_minor + t.amount_minor + t.fee_minor;
    execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',restored,restored,source.id);
    createTransaction({accountId:source.id,transferId:t.id,type:'REVERSAL',direction:'CREDIT',amountMinor:t.amount_minor+t.fee_minor,currency:source.currency,description:`Reversal of ${t.reference}`,balanceAfterMinor:restored});
    if (target) {
      const reduced = target.balance_minor - t.credited_amount_minor;
      execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',reduced,reduced,target.id);
      createTransaction({accountId:target.id,transferId:t.id,type:'REVERSAL',direction:'DEBIT',amountMinor:t.credited_amount_minor,currency:target.currency,description:`Reversal of ${t.reference}`,balanceAfterMinor:reduced});
    }
    execute('UPDATE transfers SET status=?,reversed_at=? WHERE id=?','REVERSED',nowIso(),t.id);
    notify(t.user_id,'TRANSFER_REVERSED','Transfer reversed',`${t.reference} was reversed by bank operations.`);
    audit(actorId,'REVERSE_TRANSFER','TRANSFER',t.reference,'SUCCESS',{});
    return queryOne('SELECT * FROM transfers WHERE id=?',t.id);
  });
}

function nextRecurringDate(frequency) {
  const d = new Date();
  if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate()+7);
  else if (frequency === 'MONTHLY') d.setUTCMonth(d.getUTCMonth()+1);
  else return null;
  return d.toISOString();
}

export function processBillPayment({userId,accountId,billerId,savedBillerId=null,customerReference,amountMinor,scheduledFor=null,recurringFrequency=null}) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw Object.assign(new Error('Payment amount must be greater than zero.'),{status:400});
  const account = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?',accountId,userId);
  const biller = queryOne('SELECT * FROM billers WHERE id=?',billerId);
  if (!account || !biller) throw Object.assign(new Error('Account or biller not found.'),{status:404});
  const ref = transferRef('BILL');
  if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()+30000) {
    execute(`INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,scheduled_for,recurring_frequency,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,ref,userId,accountId,billerId,savedBillerId,customerReference,amountMinor,'SCHEDULED',scheduledFor,recurringFrequency,nowIso());
    notify(userId,'BILL_SCHEDULED','Bill payment scheduled',`${biller.name} payment ${ref} is scheduled.`);
    audit(userId,'SCHEDULE_BILL_PAYMENT','BILL_PAYMENT',ref,'SUCCESS',{amountMinor,scheduledFor});
    return queryOne('SELECT * FROM bill_payments WHERE reference=?',ref);
  }
  return withTransaction(() => {
    const fresh = queryOne('SELECT * FROM accounts WHERE id=?',accountId);
    if (fresh.status !== 'ACTIVE') throw Object.assign(new Error(`Account is ${fresh.status}.`),{status:409});
    if (fresh.available_minor < amountMinor) throw Object.assign(new Error('Insufficient balance.'),{status:409});
    execute(`INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,recurring_frequency,created_at,processed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,ref,userId,accountId,billerId,savedBillerId,customerReference,amountMinor,'COMPLETED',recurringFrequency,nowIso(),nowIso());
    const paymentId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    const balance = fresh.balance_minor - amountMinor;
    execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',balance,balance,accountId);
    createTransaction({accountId,billPaymentId:paymentId,type:'BILL_PAYMENT',direction:'DEBIT',amountMinor,currency:fresh.currency,description:`${biller.name} • ${customerReference}`,balanceAfterMinor:balance});
    notify(userId,'BILL_PAID','Bill paid',`${biller.name} payment ${ref} completed.`);
    if (recurringFrequency) {
      const next = nextRecurringDate(recurringFrequency);
      if (next) execute(`INSERT INTO bill_payments (reference,user_id,account_id,biller_id,saved_biller_id,customer_reference,amount_minor,status,scheduled_for,recurring_frequency,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,transferRef('BILL'),userId,accountId,billerId,savedBillerId,customerReference,amountMinor,'SCHEDULED',next,recurringFrequency,nowIso());
    }
    audit(userId,'PAY_BILL','BILL_PAYMENT',ref,'SUCCESS',{biller:biller.code,amountMinor,recurringFrequency});
    return queryOne('SELECT * FROM bill_payments WHERE id=?',paymentId);
  });
}

export function processDueScheduledItems() {
  const now = nowIso();
  const dueTransfers = queryAll(`SELECT * FROM transfers WHERE status='PENDING' AND scheduled_for IS NOT NULL AND scheduled_for<=?`,now);
  for (const t of dueTransfers) {
    execute('UPDATE transfers SET status=? WHERE id=?','CANCELLED',t.id);
    try {
      executeTransfer({userId:t.user_id,fromAccountId:t.from_account_id,beneficiaryId:t.beneficiary_id,toOwnAccountId:t.to_account_id,amountMinor:t.amount_minor,memo:t.memo,idempotencyKey:`scheduled-${t.id}`});
    } catch (e) {
      notify(t.user_id,'TRANSFER_FAILED','Scheduled transfer failed',`${t.reference}: ${e.message}`);
    }
  }
  const dueBills = queryAll(`SELECT * FROM bill_payments WHERE status='SCHEDULED' AND scheduled_for<=?`,now);
  for (const p of dueBills) {
    execute('UPDATE bill_payments SET status=? WHERE id=?','PROCESSING',p.id);
    try {
      processBillPayment({userId:p.user_id,accountId:p.account_id,billerId:p.biller_id,savedBillerId:p.saved_biller_id,customerReference:p.customer_reference,amountMinor:p.amount_minor,recurringFrequency:p.recurring_frequency});
      execute('UPDATE bill_payments SET status=?,processed_at=? WHERE id=?','COMPLETED',nowIso(),p.id);
    } catch (e) {
      execute('UPDATE bill_payments SET status=?,failure_reason=? WHERE id=?','FAILED',e.message,p.id);
    }
  }
}

export function calculateLoanPayment(amountMinor, annualRatePercent, months) {
  const r = annualRatePercent / 100 / 12;
  if (r === 0) return Math.round(amountMinor / months);
  return Math.round(amountMinor * r * (1+r) ** months / ((1+r) ** months - 1));
}

export function reviewLoan(actorId, loanId, decision, note='') {
  return withTransaction(() => {
    const loan = queryOne('SELECT * FROM loans WHERE id=?',loanId);
    if (!loan) throw Object.assign(new Error('Loan not found.'),{status:404});
    if (!['SUBMITTED','UNDER_REVIEW'].includes(loan.status)) throw Object.assign(new Error('Loan is not awaiting review.'),{status:409});
    if (decision === 'REJECTED') {
      execute('UPDATE loans SET status=?,reviewed_at=?,reviewer_id=?,review_note=? WHERE id=?','REJECTED',nowIso(),actorId,note,loanId);
      notify(loan.user_id,'LOAN_REJECTED','Loan application update',`Your ${loan.loan_type.toLowerCase()} loan application was not approved.`);
    } else if (decision === 'APPROVED') {
      const account = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?',loan.disbursement_account_id,loan.user_id);
      if (!account || account.status !== 'ACTIVE') throw Object.assign(new Error('Disbursement account is not active.'),{status:409});
      const balance = account.balance_minor + loan.amount_minor;
      execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',balance,balance,account.id);
      execute('UPDATE loans SET status=?,reviewed_at=?,reviewer_id=?,review_note=? WHERE id=?','ACTIVE',nowIso(),actorId,note,loanId);
      createTransaction({accountId:account.id,loanId,type:'LOAN_DISBURSEMENT',direction:'CREDIT',amountMinor:loan.amount_minor,currency:account.currency,description:`${loan.loan_type} loan disbursement`,balanceAfterMinor:balance});
      notify(loan.user_id,'LOAN_APPROVED','Loan approved',`Your loan was approved and disbursed to account ending ${account.account_number.slice(-4)}.`);
    } else throw Object.assign(new Error('Decision must be APPROVED or REJECTED.'),{status:400});
    audit(actorId,'REVIEW_LOAN','LOAN',loanId,'SUCCESS',{decision,note});
    return queryOne('SELECT * FROM loans WHERE id=?',loanId);
  });
}

export function payLoan(userId, loanId, accountId, amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw Object.assign(new Error('Payment amount must be greater than zero.'),{status:400});
  return withTransaction(() => {
    const loan = queryOne('SELECT * FROM loans WHERE id=? AND user_id=?',loanId,userId);
    const account = queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?',accountId,userId);
    if (!loan || !account) throw Object.assign(new Error('Loan or account not found.'),{status:404});
    if (loan.status !== 'ACTIVE') throw Object.assign(new Error('Loan is not active.'),{status:409});
    if (account.status !== 'ACTIVE' || account.available_minor < amountMinor) throw Object.assign(new Error('Account cannot fund this payment.'),{status:409});
    const principal = Math.min(loan.remaining_principal_minor, Math.round(amountMinor * 0.85));
    const interest = amountMinor - principal;
    const balance = account.balance_minor - amountMinor;
    const remaining = Math.max(0, loan.remaining_principal_minor - principal);
    execute('UPDATE accounts SET balance_minor=?,available_minor=? WHERE id=?',balance,balance,account.id);
    execute('UPDATE loans SET remaining_principal_minor=?,status=? WHERE id=?',remaining,remaining===0?'PAID':'ACTIVE',loan.id);
    execute(`INSERT INTO loan_payments (loan_id,account_id,amount_minor,principal_minor,interest_minor,status,created_at) VALUES (?,?,?,?,?,?,?)`,loan.id,account.id,amountMinor,principal,interest,'COMPLETED',nowIso());
    createTransaction({accountId:account.id,loanId:loan.id,type:'LOAN_PAYMENT',direction:'DEBIT',amountMinor,currency:account.currency,description:`Loan #${loan.id} repayment`,balanceAfterMinor:balance});
    notify(userId,'LOAN_PAYMENT','Loan payment received',`Payment of ${(amountMinor/100).toFixed(2)} ${account.currency} was applied to loan #${loan.id}.`);
    audit(userId,'PAY_LOAN','LOAN',loan.id,'SUCCESS',{amountMinor,principal,interest});
    return queryOne('SELECT * FROM loans WHERE id=?',loan.id);
  });
}
