import { describe, test, expect } from '@jest/globals';

import {
  hashPassword,
  verifyPassword,
  randomToken,
  randomDigits,
  maskAccount,
  nowIso,
  addHours
} from '../src/security.js';

describe('hashPassword', () => {
  test('never stores the password itself', () => {
    const hash = hashPassword('Demo123!');

    expect(hash).not.toContain('Demo123!');
    expect(hash.toLowerCase()).not.toContain('demo123');
  });

  test('stores the salt alongside the digest', () => {
    const [salt, digest] = hashPassword('Demo123!').split(':');

    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  /*
   * The property that matters. Without a per-password salt, two people who
   * chose the same password would share a digest, and a single precomputed
   * table would open both accounts.
   */
  test('produces a different hash each time for the same password', () => {
    const first = hashPassword('SamePassword123!');
    const second = hashPassword('SamePassword123!');

    expect(first).not.toBe(second);
    expect(first.split(':')[0]).not.toBe(second.split(':')[0]);
  });

  test('is deterministic when the salt is supplied', () => {
    const salt = 'a'.repeat(32);

    expect(hashPassword('Demo123!', salt)).toBe(hashPassword('Demo123!', salt));
  });

  test('different passwords under one salt give different digests', () => {
    const salt = 'b'.repeat(32);

    expect(hashPassword('one', salt)).not.toBe(hashPassword('two', salt));
  });
});

describe('verifyPassword', () => {
  test('accepts the password it was built from', () => {
    expect(verifyPassword('Demo123!', hashPassword('Demo123!'))).toBe(true);
  });

  test('rejects a different password', () => {
    expect(verifyPassword('Wrong123!', hashPassword('Demo123!'))).toBe(false);
  });

  test('is case sensitive', () => {
    expect(verifyPassword('demo123!', hashPassword('Demo123!'))).toBe(false);
  });

  test('rejects a near miss', () => {
    expect(verifyPassword('Demo123', hashPassword('Demo123!'))).toBe(false);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', 'notahash'],
    ['empty digest', 'salt:'],
    ['empty salt', ':digest']
  ])('returns false rather than throwing for a %s stored value', (_label, stored) => {
    // A malformed row must fail closed. Throwing here would surface as a 500
    // on the login route, which leaks that the account exists.
    expect(() => verifyPassword('anything', stored)).not.toThrow();
    expect(verifyPassword('anything', stored)).toBe(false);
  });

  test('rejects a digest of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the implementation must catch
    // it rather than turn a bad row into a server error.
    expect(verifyPassword('anything', 'aaaa:bb')).toBe(false);
  });
});

describe('randomToken', () => {
  test('returns hex of twice the requested byte count', () => {
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken(4)).toMatch(/^[0-9a-f]{8}$/);
  });

  test('does not repeat across many draws', () => {
    // Session tokens and transfer references are built from these; a collision
    // would hand one customer another's session.
    const tokens = new Set(Array.from({ length: 500 }, () => randomToken(16)));

    expect(tokens.size).toBe(500);
  });
});

describe('randomDigits', () => {
  test('returns exactly the requested number of digits', () => {
    expect(randomDigits(6)).toMatch(/^[0-9]{6}$/);
  });

  test('pads a small value rather than returning a short code', () => {
    // A six-digit code that sometimes arrives as four would be rejected by any
    // field expecting a fixed length.
    const codes = Array.from({ length: 300 }, () => randomDigits(6));

    codes.forEach(code => expect(code).toHaveLength(6));
  });
});

describe('maskAccount', () => {
  test('reveals only the last four digits', () => {
    const masked = maskAccount('1000000001');

    // Asserting the property rather than the exact mask characters: the
    // requirement is that nothing but the last four is legible, not that the
    // padding is any particular glyph.
    expect(masked.endsWith('0001')).toBe(true);
    expect(masked).not.toContain('100000');
    expect(masked.slice(0, -4)).toMatch(/^[*]+$/);
  });

  test('masks at least as many characters as it hides', () => {
    const account = '1000000001';
    const masked = maskAccount(account);

    expect(masked.slice(0, -4).length).toBeGreaterThanOrEqual(account.length - 4);
  });

  test('leaves a short value alone rather than mangling it', () => {
    expect(maskAccount('123')).toBe('123');
  });

  test('handles an empty value', () => {
    expect(maskAccount('')).toBe('');
  });
});

describe('nowIso', () => {
  test('is ISO-8601 and therefore sorts chronologically as a string', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('two calls order correctly as plain strings', () => {
    // The schema stores timestamps as TEXT and the API filters them as
    // strings, so lexicographic order must equal chronological order.
    const earlier = nowIso();
    const later = new Date(Date.now() + 1000).toISOString();

    expect(earlier < later).toBe(true);
  });
});

describe('addHours', () => {
  test('returns a time in the future', () => {
    expect(new Date(addHours(8)).getTime()).toBeGreaterThan(Date.now());
  });

  test('adds the hours it was asked for', () => {
    const eight = new Date(addHours(8)).getTime();
    const expected = Date.now() + 8 * 3600 * 1000;

    expect(Math.abs(eight - expected)).toBeLessThan(2000);
  });

  test('a remembered device outlasts a normal session', () => {
    expect(new Date(addHours(24 * 30)).getTime())
      .toBeGreaterThan(new Date(addHours(8)).getTime());
  });

  test('returns ISO-8601, matching how expiry is compared', () => {
    // Session expiry is checked with expires_at > nowIso(), a string compare.
    expect(addHours(1)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(addHours(1) > nowIso()).toBe(true);
  });
});
