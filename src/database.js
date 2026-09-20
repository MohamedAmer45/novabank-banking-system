import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool, types } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/*
 * node-postgres returns BIGINT (OID 20) as a string so values beyond
 * Number.MAX_SAFE_INTEGER survive the round trip. Every BIGINT in this schema
 * is a surrogate key, so string ids would silently break the `===` comparisons
 * and ownership checks the SQLite build relied on. Parsing them back to numbers
 * keeps every call site identical to the original implementation.
 */
types.setTypeParser(20, value => Number(value));

/*
 * NUMERIC (OID 1700) would also arrive as a string. Money is stored in minor
 * units as BIGINT, so NUMERIC only carries interest rates and FX rates.
 */
types.setTypeParser(1700, value => Number(value));

/*
 * Tables keyed by a TEXT primary key rather than a generated id. `execute`
 * must not append RETURNING id for these.
 */
const TABLES_WITHOUT_ID = new Set([
  'sessions',
  'verification_tokens'
]);

let pool = null;

export function getPool() {
  if (pool) return pool;

  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not configured. Copy .env.example to .env and set it.'
    );
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', error => {
    console.error('Unexpected PostgreSQL pool error:', error);
  });

  return pool;
}

export async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/*
 * The original build used SQLite's positional `?` placeholders. Rewriting them
 * here rather than at 500+ call sites keeps the SQL in banking.js readable and
 * diffable against the SQLite implementation it was ported from.
 */
export function toPositional(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const transactionStorage = new AsyncLocalStorage();

function activeClient() {
  return transactionStorage.getStore()?.client ?? getPool();
}

export async function queryAll(sql, ...params) {
  const result = await activeClient().query(toPositional(sql), params);
  return result.rows;
}

export async function queryOne(sql, ...params) {
  const result = await activeClient().query(toPositional(sql), params);
  return result.rows[0];
}

/*
 * Mirrors the shape node:sqlite returned, so the thirteen call sites that read
 * `lastInsertRowid` keep working unchanged.
 */
export async function execute(sql, ...params) {
  const text = withReturningId(sql);
  const result = await activeClient().query(toPositional(text), params);

  return {
    changes: result.rowCount,
    lastInsertRowid: result.rows[0]?.id
  };
}

function withReturningId(sql) {
  if (!/^\s*INSERT\s+INTO/i.test(sql)) return sql;
  if (/\bRETURNING\b/i.test(sql)) return sql;

  const table = sql.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i)?.[1];
  if (!table || TABLES_WITHOUT_ID.has(table.toLowerCase())) return sql;

  return `${sql.trimEnd()} RETURNING id`;
}

/*
 * BEGIN/COMMIT must run on the same connection as the statements they wrap, so
 * the transaction pins one client and publishes it through AsyncLocalStorage.
 * Nested calls join the outer transaction rather than opening a second one,
 * matching how the SQLite build behaved under BEGIN IMMEDIATE.
 */
export async function withTransaction(fn) {
  if (transactionStorage.getStore()) {
    return fn();
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await transactionStorage.run({ client }, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export function inTransaction() {
  return transactionStorage.getStore() !== undefined;
}

export async function applySchema() {
  const schema = fs.readFileSync(
    path.join(ROOT_DIR, 'database', 'postgres-schema.sql'),
    'utf8'
  );

  await getPool().query(schema);
}

export async function checkDatabaseConnection() {
  try {
    const row = await queryOne('SELECT NOW() AS current_time');
    return { connected: true, currentTime: row.current_time };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

export async function isSeeded() {
  const row = await queryOne('SELECT COUNT(*)::int AS count FROM users');
  return Number(row?.count ?? 0) > 0;
}
