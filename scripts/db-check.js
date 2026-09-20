import 'dotenv/config';

import { queryAll, queryOne, checkDatabaseConnection, closePool } from '../src/database.js';

const EXPECTED_TABLES = [
  'accounts', 'audit_logs', 'beneficiaries', 'bill_payments', 'billers', 'cards',
  'fraud_alerts', 'kyc_profiles', 'loan_payments', 'loans', 'notifications',
  'saved_billers', 'sessions', 'transactions', 'transfers', 'users',
  'verification_tokens'
];

async function check() {
  const health = await checkDatabaseConnection();

  console.log(`Connection : ${health.connected ? 'OK' : 'FAILED'}`);
  if (!health.connected) {
    console.error(`  ${health.error}`);
    process.exitCode = 1;
    return;
  }

  const rows = await queryAll(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name`
  );
  const present = new Set(rows.map(r => r.table_name));
  const missing = EXPECTED_TABLES.filter(t => !present.has(t));

  console.log(`Tables     : ${present.size} present, ${missing.length} missing`);
  if (missing.length) {
    console.error(`  missing: ${missing.join(', ')}`);
    console.error('  run: npm run db:migrate');
    process.exitCode = 1;
    return;
  }

  const counts = {};
  for (const table of ['users', 'accounts', 'transfers', 'transactions', 'loans']) {
    const row = await queryOne(`SELECT COUNT(*)::int AS count FROM ${table}`);
    counts[table] = row.count;
  }

  console.log('Row counts :');
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(14)} ${count}`);
  }

  if (counts.users === 0) {
    console.log('\nDatabase is empty. Run: npm run db:seed');
  }

  /*
   * The ledger invariant: every account balance must equal the balance_after
   * recorded on its most recent transaction. A mismatch means a money movement
   * updated one without the other.
   */
  const drift = await queryAll(
    `SELECT a.id, a.account_number, a.balance_minor, t.balance_after_minor
       FROM accounts a
       JOIN LATERAL (
         SELECT balance_after_minor
           FROM transactions
          WHERE account_id = a.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) t ON TRUE
      WHERE a.balance_minor <> t.balance_after_minor`
  );

  if (drift.length === 0) {
    console.log('\nLedger     : OK (every balance matches its latest transaction)');
  } else {
    console.error(`\nLedger     : ${drift.length} account(s) out of sync`);
    for (const row of drift) {
      console.error(
        `  account ${row.account_number}: balance ${row.balance_minor}` +
        ` vs ledger ${row.balance_after_minor}`
      );
    }
    process.exitCode = 1;
  }
}

check()
  .catch(err => {
    console.error('Check failed:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
