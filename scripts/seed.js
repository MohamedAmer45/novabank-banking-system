import 'dotenv/config';

import { execute, queryOne, withTransaction, closePool } from '../src/database.js';
import { hashPassword, nowIso } from '../src/security.js';

const FORCE = process.argv.includes('--force');

const DEMO_MFA_CODE = '123456';
const DEFAULT_PHONE = '+20 100 000 0000';

async function insertUser(email, password, first, last, role = 'CUSTOMER') {
  const result = await execute(
    `INSERT INTO users (email,password_hash,first_name,last_name,phone,role,status,email_verified,mfa_enabled,mfa_code,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    email, hashPassword(password), first, last, DEFAULT_PHONE,
    role, 'ACTIVE', 1, 1, DEMO_MFA_CODE, nowIso()
  );
  return result.lastInsertRowid;
}

async function insertAccount(
  userId, number, iban, type, currency, balanceMinor, dailyLimitMinor = 25000000
) {
  const now = nowIso();

  const result = await execute(
    `INSERT INTO accounts (user_id,account_number,iban,account_type,currency,balance_minor,available_minor,status,daily_limit_minor,daily_transferred_minor,daily_counter_date,opened_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, number, iban, type, currency, balanceMinor, balanceMinor,
    'ACTIVE', dailyLimitMinor, 0, now.slice(0, 10), now
  );

  const accountId = result.lastInsertRowid;

  await execute(
    `INSERT INTO transactions (reference,account_id,transaction_type,direction,amount_minor,fee_minor,currency,status,description,balance_after_minor,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    `TXN-OPEN-${accountId}-${Date.now()}`, accountId, 'DEPOSIT', 'CREDIT',
    balanceMinor, 0, currency, 'COMPLETED', 'Opening balance', balanceMinor, nowIso()
  );

  return accountId;
}

async function insertKyc(userId, status, profile, reviewerId = null) {
  await execute(
    `INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,reviewer_note,reviewed_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, status, profile.dateOfBirth, profile.nationality, profile.address,
    profile.employment, profile.annualIncomeMinor, 'NATIONAL_ID', profile.idNumber,
    profile.documentName, profile.reviewerNote || null, reviewerId, nowIso()
  );
}

async function seed() {
  const existing = await queryOne('SELECT COUNT(*)::int AS count FROM users');

  if (Number(existing.count) > 0 && !FORCE) {
    console.log(
      `Database already contains ${existing.count} users. ` +
      'Pass --force to seed anyway, or run: npm run db:reset'
    );
    return;
  }

  await withTransaction(async () => {
    // ---------------------------------------------------------- users
    const customerId = await insertUser(
      'customer@novabank.test', 'Demo123!', 'Mohamed', 'Amer'
    );
    const receiverId = await insertUser(
      'receiver@novabank.test', 'Demo123!', 'Nadia', 'Hassan'
    );
    const adminId = await insertUser(
      'admin@novabank.test', 'Admin123!', 'Nora', 'Admin', 'ADMIN'
    );
    await insertUser('manager@novabank.test', 'Manager123!', 'Karim', 'Manager', 'MANAGER');
    await insertUser('support@novabank.test', 'Support123!', 'Maya', 'Support', 'SUPPORT');
    await insertUser('auditor@novabank.test', 'Auditor123!', 'Omar', 'Auditor', 'AUDITOR');
    await insertUser('employee@novabank.test', 'Employee123!', 'Salma', 'Employee', 'EMPLOYEE');

    // ------------------------------------------------------------ kyc
    await insertKyc(customerId, 'VERIFIED', {
      dateOfBirth: '1999-04-18',
      nationality: 'Egyptian',
      address: 'Sheikh Zayed, Giza, Egypt',
      employment: 'Software Quality Engineer',
      annualIncomeMinor: 72000000,
      idNumber: '29804181234567',
      documentName: 'national-id-demo.pdf',
      reviewerNote: 'Seeded verified customer for QA scenarios'
    }, adminId);

    await insertKyc(receiverId, 'VERIFIED', {
      dateOfBirth: '1997-07-05',
      nationality: 'Egyptian',
      address: 'Cairo, Egypt',
      employment: 'Designer',
      annualIncomeMinor: 48000000,
      idNumber: '29707051234567',
      documentName: 'receiver-id-demo.pdf',
      reviewerNote: 'Verified'
    }, adminId);

    // ------------------------------------------------------- accounts
    const currentId = await insertAccount(
      customerId, '1000000001', 'EG380001000000001000000001', 'CURRENT', 'EGP', 25000000, 15000000
    );
    await insertAccount(
      customerId, '1000000002', 'EG380001000000001000000002', 'SAVINGS', 'EGP', 8000000, 10000000
    );
    await insertAccount(
      customerId, '2000000001', 'EG380001000000002000000001', 'SAVINGS', 'USD', 150000, 500000
    );
    await insertAccount(
      receiverId, '1000000003', 'EG380001000000001000000003', 'CURRENT', 'EGP', 4000000, 15000000
    );

    // --------------------------------------------------- beneficiaries
    await execute(
      `INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      customerId, 'Nadia Hassan', 'NOVABANK', '1000000003', 'EGP', 'Nadia', 'ACTIVE', 1, nowIso()
    );
    await execute(
      `INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      customerId, 'External Test Recipient', 'NILE EXTERNAL BANK', 'EXT-998877', 'EGP',
      'External Demo', 'ACTIVE', 1, nowIso()
    );

    // ----------------------------------------------------------- card
    await execute(
      `INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      customerId, currentId, '4242', 'MOHAMED AMER', 'DEBIT', 'ACTIVE', 12, 2030, nowIso()
    );

    // -------------------------------------------------------- billers
    const billers = [
      ['ELEC-CAIRO', 'Cairo Electricity', 'Electricity', 'Meter number'],
      ['WATER-GIZA', 'Giza Water', 'Water', 'Subscriber number'],
      ['GAS-NAT', 'Natural Gas', 'Gas', 'Customer number'],
      ['ISP-FIBER', 'FiberNet Internet', 'Internet', 'Landline / account number'],
      ['MOBILE-01', 'Mobile One', 'Mobile', 'Mobile number'],
      ['CC-PAY', 'Credit Card Payment', 'Credit Card', 'Card reference']
    ];

    for (const biller of billers) {
      await execute(
        'INSERT INTO billers (code,name,category,customer_reference_label) VALUES (?,?,?,?)',
        ...biller
      );
    }

    const electricity = await queryOne("SELECT id FROM billers WHERE code='ELEC-CAIRO'");
    await execute(
      `INSERT INTO saved_billers (user_id,biller_id,alias,customer_reference,created_at)
       VALUES (?,?,?,?,?)`,
      customerId, electricity.id, 'Home Electricity', 'MTR-44118822', nowIso()
    );

    await execute(
      `INSERT INTO notifications (user_id,channel,notification_type,title,message,created_at)
       VALUES (?,?,?,?,?,?)`,
      customerId, 'IN_APP', 'WELCOME', 'Welcome to NovaBank',
      'Your demo banking profile is ready for testing.', nowIso()
    );

    /*
     * A customer awaiting KYC review and a loan awaiting a decision, so the
     * back-office queues are never empty on a freshly seeded database.
     */
    const pendingId = await insertUser(
      'pending@novabank.test', 'Demo123!', 'Youssef', 'Ali'
    );
    await insertKyc(pendingId, 'UNDER_REVIEW', {
      dateOfBirth: '1995-03-12',
      nationality: 'Egyptian',
      address: 'Giza, Egypt',
      employment: 'Accountant',
      annualIncomeMinor: 36000000,
      idNumber: '29503121234567',
      documentName: 'pending-id.pdf'
    });
    await insertAccount(
      pendingId, '1000000004', 'EG380001000000001000000004', 'CURRENT', 'EGP', 500000, 5000000
    );

    const monthlyRate = 0.18 / 12;
    const monthlyPayment = Math.round(
      (10000000 * monthlyRate * (1 + monthlyRate) ** 24) / (((1 + monthlyRate) ** 24) - 1)
    );

    await execute(
      `INSERT INTO loans (user_id,loan_type,amount_minor,interest_rate,term_months,monthly_payment_minor,remaining_principal_minor,purpose,status,disbursement_account_id,applied_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      customerId, 'PERSONAL', 10000000, 18, 24, monthlyPayment, 10000000,
      'Home office equipment', 'SUBMITTED', currentId, nowIso()
    );

    await execute(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,result,metadata_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      adminId, 'SEED_DATABASE', 'SYSTEM', 'novabank', '127.0.0.1', 'SUCCESS', '{}', nowIso()
    );
  });

  console.log('Seed complete.\n');
  console.log('  customer@novabank.test  Demo123!      CUSTOMER  (KYC verified)');
  console.log('  receiver@novabank.test  Demo123!      CUSTOMER  (transfer destination)');
  console.log('  pending@novabank.test   Demo123!      CUSTOMER  (KYC under review)');
  console.log('  admin@novabank.test     Admin123!     ADMIN');
  console.log('  manager@novabank.test   Manager123!   MANAGER');
  console.log('  support@novabank.test   Support123!   SUPPORT');
  console.log('  auditor@novabank.test   Auditor123!   AUDITOR');
  console.log('  employee@novabank.test  Employee123!  EMPLOYEE');
  console.log(`\n  MFA code for every seeded user: ${DEMO_MFA_CODE}`);
}

seed()
  .catch(err => {
    console.error('Seed failed:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
