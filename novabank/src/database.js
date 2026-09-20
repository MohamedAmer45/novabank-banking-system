import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, nowIso } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.NOVABANK_DB || path.join(root, 'novabank.db');
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export function initDatabase() {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  db.exec(schema);
  const kycColumns = new Set(db.prepare('PRAGMA table_info(kyc_profiles)').all().map(c => c.name));
  if (!kycColumns.has('document_mime')) db.exec('ALTER TABLE kyc_profiles ADD COLUMN document_mime TEXT');
  if (!kycColumns.has('document_data_b64')) db.exec('ALTER TABLE kyc_profiles ADD COLUMN document_data_b64 TEXT');
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (Number(count) === 0) seedDatabase();
}

function insertUser(email, password, first, last, role = 'CUSTOMER', verified = 1, mfa = 1) {
  const result = db.prepare(`
    INSERT INTO users (email,password_hash,first_name,last_name,phone,role,status,email_verified,mfa_enabled,mfa_code,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(email, hashPassword(password), first, last, '+20 100 000 0000', role, 'ACTIVE', verified, mfa, '123456', nowIso());
  return Number(result.lastInsertRowid);
}

function insertAccount(userId, number, iban, type, currency, balanceMinor, dailyLimitMinor = 25000000) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO accounts (user_id,account_number,iban,account_type,currency,balance_minor,available_minor,status,daily_limit_minor,daily_transferred_minor,daily_counter_date,opened_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(userId, number, iban, type, currency, balanceMinor, balanceMinor, 'ACTIVE', dailyLimitMinor, 0, now.slice(0,10), now);
  return Number(result.lastInsertRowid);
}

function addOpeningTransaction(accountId, amountMinor, currency, description = 'Opening balance') {
  db.prepare(`INSERT INTO transactions
    (reference,account_id,transaction_type,direction,amount_minor,fee_minor,currency,status,description,balance_after_minor,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`TXN-OPEN-${accountId}-${Date.now()}`, accountId, 'DEPOSIT', 'CREDIT', amountMinor, 0, currency, 'COMPLETED', description, amountMinor, nowIso());
}

export function seedDatabase() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const customerId = insertUser('customer@novabank.test', 'Demo123!', 'Mohamed', 'Amer', 'CUSTOMER', 1, 1);
    const secondCustomer = insertUser('receiver@novabank.test', 'Demo123!', 'Nadia', 'Hassan', 'CUSTOMER', 1, 1);
    const adminId = insertUser('admin@novabank.test', 'Admin123!', 'Nora', 'Admin', 'ADMIN', 1, 1);
    const managerId = insertUser('manager@novabank.test', 'Manager123!', 'Karim', 'Manager', 'MANAGER', 1, 1);
    insertUser('support@novabank.test', 'Support123!', 'Maya', 'Support', 'SUPPORT', 1, 1);
    insertUser('auditor@novabank.test', 'Auditor123!', 'Omar', 'Auditor', 'AUDITOR', 1, 1);
    insertUser('employee@novabank.test', 'Employee123!', 'Salma', 'Employee', 'EMPLOYEE', 1, 1);

    db.prepare(`INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,reviewer_note,reviewed_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(customerId, 'VERIFIED', '1999-04-18', 'Egyptian', 'Sheikh Zayed, Giza, Egypt', 'Software Quality Engineer', 72000000, 'NATIONAL_ID', '29804181234567', 'national-id-demo.pdf', 'Seeded verified customer for QA scenarios', adminId, nowIso());
    db.prepare(`INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,reviewer_note,reviewed_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(secondCustomer, 'VERIFIED', '1997-07-05', 'Egyptian', 'Cairo, Egypt', 'Designer', 48000000, 'NATIONAL_ID', '29707051234567', 'receiver-id-demo.pdf', 'Verified', adminId, nowIso());

    const currentId = insertAccount(customerId, '1000000001', 'EG380001000000001000000001', 'CURRENT', 'EGP', 25000000, 15000000);
    const savingsId = insertAccount(customerId, '1000000002', 'EG380001000000001000000002', 'SAVINGS', 'EGP', 8000000, 10000000);
    const usdId = insertAccount(customerId, '2000000001', 'EG380001000000002000000001', 'SAVINGS', 'USD', 150000, 500000);
    const receiverCurrent = insertAccount(secondCustomer, '1000000003', 'EG380001000000001000000003', 'CURRENT', 'EGP', 4000000, 15000000);
    addOpeningTransaction(currentId, 25000000, 'EGP');
    addOpeningTransaction(savingsId, 8000000, 'EGP');
    addOpeningTransaction(usdId, 150000, 'USD');
    addOpeningTransaction(receiverCurrent, 4000000, 'EGP');

    db.prepare(`INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(customerId, 'Nadia Hassan', 'NOVABANK', '1000000003', 'EGP', 'Nadia', 'ACTIVE', 1, nowIso());
    db.prepare(`INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(customerId, 'External Test Recipient', 'NILE EXTERNAL BANK', 'EXT-998877', 'EGP', 'External Demo', 'ACTIVE', 1, nowIso());

    db.prepare(`INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(customerId, currentId, '4242', 'MOHAMED AMER', 'DEBIT', 'ACTIVE', 12, 2030, nowIso());

    const billers = [
      ['ELEC-CAIRO','Cairo Electricity','Electricity','Meter number'],
      ['WATER-GIZA','Giza Water','Water','Subscriber number'],
      ['GAS-NAT','Natural Gas','Gas','Customer number'],
      ['ISP-FIBER','FiberNet Internet','Internet','Landline / account number'],
      ['MOBILE-01','Mobile One','Mobile','Mobile number'],
      ['CC-PAY','Credit Card Payment','Credit Card','Card reference']
    ];
    const billerStmt = db.prepare('INSERT INTO billers (code,name,category,customer_reference_label) VALUES (?,?,?,?)');
    for (const b of billers) billerStmt.run(...b);

    const elec = db.prepare("SELECT id FROM billers WHERE code='ELEC-CAIRO'").get();
    db.prepare(`INSERT INTO saved_billers (user_id,biller_id,alias,customer_reference,created_at) VALUES (?,?,?,?,?)`)
      .run(customerId, elec.id, 'Home Electricity', 'MTR-44118822', nowIso());

    db.prepare(`INSERT INTO notifications (user_id,channel,notification_type,title,message,created_at) VALUES (?,?,?,?,?,?)`)
      .run(customerId, 'IN_APP', 'WELCOME', 'Welcome to NovaBank', 'Your demo banking profile is ready for testing.', nowIso());

    // Seed one pending KYC and one submitted loan so back-office queues are never empty.
    const pendingId = insertUser('pending@novabank.test', 'Demo123!', 'Youssef', 'Ali', 'CUSTOMER', 1, 1);
    db.prepare(`INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pendingId, 'UNDER_REVIEW', '1995-03-12', 'Egyptian', 'Giza, Egypt', 'Accountant', 36000000, 'NATIONAL_ID', '29503121234567', 'pending-id.pdf', nowIso());
    const pendingAccount = insertAccount(pendingId, '1000000004', 'EG380001000000001000000004', 'CURRENT', 'EGP', 500000, 5000000);
    addOpeningTransaction(pendingAccount, 500000, 'EGP');

    const monthly = Math.round((10000000 * (0.18/12) * (1+0.18/12) ** 24) / (((1+0.18/12) ** 24) - 1));
    db.prepare(`INSERT INTO loans (user_id,loan_type,amount_minor,interest_rate,term_months,monthly_payment_minor,remaining_principal_minor,purpose,status,disbursement_account_id,applied_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(customerId, 'PERSONAL', 10000000, 18, 24, monthly, 10000000, 'Home office equipment', 'SUBMITTED', currentId, nowIso());

    db.prepare(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,result,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(adminId, 'SEED_DATABASE', 'SYSTEM', 'novabank', '127.0.0.1', 'SUCCESS', JSON.stringify({managerId}), nowIso());

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function queryAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function queryOne(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function execute(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const ROOT_DIR = root;
