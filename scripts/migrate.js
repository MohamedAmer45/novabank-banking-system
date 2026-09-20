import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { getPool, closePool, ROOT_DIR } from '../src/database.js';

const RESET = process.argv.includes('--reset');

/*
 * Every table this application owns, ordered so that --reset names them
 * explicitly rather than dropping the whole schema. Anything else living in
 * the database is left alone.
 */
const OWNED_TABLES = [
  'loan_payments', 'bill_payments', 'saved_billers', 'billers',
  'transactions', 'transfers', 'beneficiaries', 'cards', 'loans',
  'fraud_alerts', 'notifications', 'audit_logs', 'kyc_profiles',
  'accounts', 'sessions', 'verification_tokens', 'users',
  'schema_migrations'
];

async function migrate() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    if (RESET) {
      console.log(`RESET  dropping ${OWNED_TABLES.length} application tables`);
      for (const table of OWNED_TABLES) {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    }

    const schemaPath = path.join(ROOT_DIR, 'database', 'postgres-schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('APPLY  database/postgres-schema.sql');

    /*
     * The schema is written with IF NOT EXISTS throughout, so applying it to an
     * existing database is a no-op. It runs in one transaction so a partial
     * schema can never be left behind.
     */
    await client.query('BEGIN');
    try {
      await client.query(schema);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const { rows } = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );

    console.log(`\nMigration complete. ${rows.length} tables present:`);
    for (const row of rows) console.log(`  - ${row.table_name}`);
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch(err => {
  console.error('Migration failed:');
  console.error(err);
  process.exit(1);
});
