import { describe, test, expect } from '@jest/globals';

import { toPositional, withReturningId } from '../src/database.js';

/*
 * These two functions sit between the application and every query it makes.
 * Nothing else tests them directly: the API suites exercise them a thousand
 * times over but would report a fault in them as "the transfer was wrong",
 * which is a long way from the line that caused it.
 */

describe('toPositional', () => {
  test('rewrites each placeholder in order', () => {
    expect(toPositional('SELECT * FROM accounts WHERE id=? AND user_id=?'))
      .toBe('SELECT * FROM accounts WHERE id=$1 AND user_id=$2');
  });

  test('numbers placeholders by position, not by value', () => {
    // The failure that matters here is misalignment: if the counter were
    // reset or shared, parameters would silently bind to the wrong columns.
    expect(toPositional('INSERT INTO t (a,b,c,d) VALUES (?,?,?,?)'))
      .toBe('INSERT INTO t (a,b,c,d) VALUES ($1,$2,$3,$4)');
  });

  test('leaves SQL without placeholders untouched', () => {
    const sql = 'SELECT COUNT(*) FROM users';
    expect(toPositional(sql)).toBe(sql);
  });

  test('handles a placeholder as the very first character', () => {
    expect(toPositional('? = ANY(tags)')).toBe('$1 = ANY(tags)');
  });

  test('counts past nine without transposing digits', () => {
    const sql = 'INSERT INTO t VALUES (' + Array(12).fill('?').join(',') + ')';
    const rewritten = toPositional(sql);

    expect(rewritten).toContain('$9,$10,$11,$12');
    expect(rewritten).not.toContain('$10,$11,$12)0');
  });

  test('is stateless across calls', () => {
    // A counter held outside the function would make the second call start
    // at $3, and every query after the first would be wrong.
    const first = toPositional('WHERE a=? AND b=?');
    const second = toPositional('WHERE a=? AND b=?');

    expect(second).toBe(first);
    expect(second).toBe('WHERE a=$1 AND b=$2');
  });

  test('rewrites every placeholder in the longest real statement', () => {
    // The transfers insert, which carries sixteen parameters.
    const sql = `INSERT INTO transfers (reference,user_id,from_account_id,
      beneficiary_id,to_account_id,transfer_type,source_currency,target_currency,
      fx_rate,amount_minor,credited_amount_minor,fee_minor,status,memo,
      idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    const rewritten = toPositional(sql);

    expect(rewritten).not.toContain('?');
    expect(rewritten).toContain('$16');
    expect(rewritten).not.toContain('$17');
  });

  /*
   * A known limitation, asserted so it is a documented boundary rather than a
   * surprise. A question mark inside a string literal would also be rewritten.
   * No query in this application contains one — the SQL is all parameterised,
   * which is why the simple approach is safe here — but a future query with a
   * literal '?' in it would break, and this test says so out loud.
   */
  test('does not distinguish a placeholder from a question mark in a literal', () => {
    expect(toPositional("SELECT 'why?' AS q WHERE id=?"))
      .toBe("SELECT 'why$1' AS q WHERE id=$2");
  });
});

describe('withReturningId', () => {
  test('appends RETURNING id to an insert', () => {
    expect(withReturningId('INSERT INTO users (email) VALUES (?)'))
      .toBe('INSERT INTO users (email) VALUES (?) RETURNING id');
  });

  test('leaves a select alone', () => {
    const sql = 'SELECT * FROM users WHERE id=?';
    expect(withReturningId(sql)).toBe(sql);
  });

  test('leaves an update alone', () => {
    const sql = 'UPDATE users SET email=? WHERE id=?';
    expect(withReturningId(sql)).toBe(sql);
  });

  test('leaves a delete alone', () => {
    const sql = 'DELETE FROM sessions WHERE token=?';
    expect(withReturningId(sql)).toBe(sql);
  });

  test('does not append twice when RETURNING is already present', () => {
    const sql = 'INSERT INTO users (email) VALUES (?) RETURNING id, email';
    expect(withReturningId(sql)).toBe(sql);
  });

  /*
   * sessions and verification_tokens are keyed by a TEXT token rather than a
   * generated id. Appending RETURNING id to those inserts would make every
   * sign-in fail with an undefined-column error.
   */
  test.each(['sessions', 'verification_tokens'])(
    'never appends RETURNING id for %s, which has no id column',
    table => {
      const sql = `INSERT INTO ${table} (token,user_id) VALUES (?,?)`;
      expect(withReturningId(sql)).toBe(sql);
    }
  );

  test.each([
    'users', 'accounts', 'transfers', 'transactions', 'cards',
    'beneficiaries', 'loans', 'bill_payments', 'notifications',
    'audit_logs', 'fraud_alerts', 'kyc_profiles'
  ])('appends RETURNING id for %s, which has one', table => {
    const sql = `INSERT INTO ${table} (a) VALUES (?)`;
    expect(withReturningId(sql)).toBe(`${sql} RETURNING id`);
  });

  test('tolerates leading whitespace and mixed case', () => {
    expect(withReturningId('\n  insert into users (email) values (?)'))
      .toContain('RETURNING id');
  });

  test('trims trailing whitespace before appending', () => {
    expect(withReturningId('INSERT INTO users (a) VALUES (?)\n   '))
      .toBe('INSERT INTO users (a) VALUES (?) RETURNING id');
  });
});
