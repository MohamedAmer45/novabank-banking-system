import { describe, test, expect } from '@jest/globals';

import { ROLE_PERMISSIONS, hasPermission, bearer, sanitizeIdNumber } from '../src/lib/access.js';
import { publicUser } from '../src/banking.js';

const ROLES = ['CUSTOMER', 'SUPPORT', 'AUDITOR', 'EMPLOYEE', 'MANAGER', 'ADMIN'];

describe('the permission table', () => {
  test('defines every role the application issues', () => {
    ROLES.forEach(role => expect(ROLE_PERMISSIONS).toHaveProperty(role));
  });

  test('a customer holds no back-office permission at all', () => {
    // Customer access is scoped by ownership, not by permission. An entry here
    // would grant it across every customer at once.
    expect(ROLE_PERMISSIONS.CUSTOMER).toEqual([]);
  });

  test('only ADMIN holds the wildcard', () => {
    const wildcarded = ROLES.filter(r => ROLE_PERMISSIONS[r].includes('*'));

    expect(wildcarded).toEqual(['ADMIN']);
  });
});

describe('hasPermission', () => {
  test('grants a permission a role holds', () => {
    expect(hasPermission({ role: 'SUPPORT' }, 'READ_CUSTOMERS')).toBe(true);
  });

  test('refuses a permission a role does not hold', () => {
    expect(hasPermission({ role: 'SUPPORT' }, 'REVERSE_TRANSFER')).toBe(false);
  });

  test('the wildcard grants everything', () => {
    ['READ_AUDIT', 'REVERSE_TRANSFER', 'MANAGE_LIMITS', 'ANYTHING_AT_ALL']
      .forEach(p => expect(hasPermission({ role: 'ADMIN' }, p)).toBe(true));
  });

  test('an unknown role is refused rather than defaulting open', () => {
    // A typo in a role name must fail closed.
    expect(hasPermission({ role: 'SUPERUSER' }, 'READ_CUSTOMERS')).toBe(false);
    expect(hasPermission({ role: undefined }, 'READ_CUSTOMERS')).toBe(false);
  });

  test('an unknown permission is refused for a non-wildcard role', () => {
    expect(hasPermission({ role: 'MANAGER' }, 'DELETE_EVERYTHING')).toBe(false);
  });

  /*
   * The grid, asserted as a whole. A permission table is only correct if every
   * cell is, and the failure worth catching is a role quietly gaining access:
   * a matrix shows that as one wrong cell, where individual tests show it as a
   * test nobody thought to write.
   */
  const GRID = {
    READ_CUSTOMERS: ['SUPPORT', 'AUDITOR', 'EMPLOYEE', 'MANAGER', 'ADMIN'],
    READ_ACCOUNTS: ['SUPPORT', 'AUDITOR', 'EMPLOYEE', 'MANAGER', 'ADMIN'],
    READ_TRANSFERS: ['SUPPORT', 'AUDITOR', 'EMPLOYEE', 'MANAGER', 'ADMIN'],
    READ_AUDIT: ['AUDITOR', 'MANAGER', 'ADMIN'],
    READ_FRAUD: ['AUDITOR', 'MANAGER', 'ADMIN'],
    REVIEW_KYC: ['EMPLOYEE', 'MANAGER', 'ADMIN'],
    MANAGE_ACCOUNTS: ['MANAGER', 'ADMIN'],
    MANAGE_LIMITS: ['MANAGER', 'ADMIN'],
    REVERSE_TRANSFER: ['MANAGER', 'ADMIN'],
    REVIEW_LOANS: ['MANAGER', 'ADMIN'],
    MANAGE_FRAUD: ['MANAGER', 'ADMIN']
  };

  test.each(Object.entries(GRID))(
    '%s is held by exactly the expected roles',
    (permission, expected) => {
      const actual = ROLES.filter(role => hasPermission({ role }, permission));

      expect(actual.sort()).toEqual([...expected].sort());
    }
  );

  test('every permission in the table appears in the grid above', () => {
    // Guards against a permission being added to the table without anyone
    // deciding, in a test, which roles should hold it.
    const declared = new Set(
      ROLES.flatMap(r => ROLE_PERMISSIONS[r]).filter(p => p !== '*')
    );

    declared.forEach(p => expect(Object.keys(GRID)).toContain(p));
  });
});

describe('bearer', () => {
  test('extracts the token from a well-formed header', () => {
    expect(bearer({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
  });

  test('returns null when the header is absent', () => {
    expect(bearer({ headers: {} })).toBeNull();
  });

  test.each([
    ['wrong scheme', 'Basic abc123'],
    ['lowercase scheme', 'bearer abc123'],
    ['no scheme', 'abc123'],
    ['empty', '']
  ])('returns null for a %s header', (_label, value) => {
    expect(bearer({ headers: { authorization: value } })).toBeNull();
  });

  test('does not trim, so a padded token fails rather than half-matching', () => {
    expect(bearer({ headers: { authorization: 'Bearer  abc' } })).toBe(' abc');
  });
});

describe('publicUser', () => {
  const stored = {
    id: 1,
    email: 'customer@novabank.test',
    role: 'CUSTOMER',
    password_hash: 'salt:digest',
    mfa_code: '123456'
  };

  test('strips the password hash and the one-time code', () => {
    const safe = publicUser(stored);

    expect(safe).not.toHaveProperty('password_hash');
    expect(safe).not.toHaveProperty('mfa_code');
  });

  test('keeps the fields a client legitimately needs', () => {
    const safe = publicUser(stored);

    expect(safe.id).toBe(1);
    expect(safe.email).toBe('customer@novabank.test');
    expect(safe.role).toBe('CUSTOMER');
  });

  test('does not mutate the row it was given', () => {
    // The same row object is used again by the caller; stripping in place
    // would remove the hash the login flow is about to verify against.
    const row = { ...stored };
    publicUser(row);

    expect(row.password_hash).toBe('salt:digest');
  });

  test('returns null for no user rather than an empty object', () => {
    expect(publicUser(null)).toBeNull();
    expect(publicUser(undefined)).toBeNull();
  });

  test('serialising the result never reveals a credential', () => {
    const json = JSON.stringify(publicUser(stored));

    expect(json).not.toContain('salt:digest');
    expect(json).not.toContain('123456');
  });
});

describe('sanitizeIdNumber', () => {
  const profile = {
    user_id: 1,
    status: 'VERIFIED',
    id_number: '29804181234567',
    document_data_b64: 'JVBERi0xLjQK'
  };

  test('reveals only the last four of the identity number', () => {
    const safe = sanitizeIdNumber(profile);

    expect(safe.id_number).toBe('**********4567');
    expect(safe.id_number).not.toContain('2980418');
  });

  test('removes the document payload entirely', () => {
    const safe = sanitizeIdNumber(profile);

    expect(safe).not.toHaveProperty('document_data_b64');
  });

  test('reports whether a document exists without shipping it', () => {
    expect(sanitizeIdNumber(profile).has_document).toBe(true);
    expect(sanitizeIdNumber({ ...profile, document_data_b64: null }).has_document).toBe(false);
  });

  test('handles a profile with no identity number', () => {
    expect(sanitizeIdNumber({ ...profile, id_number: null }).id_number).toBeNull();
  });

  test('passes a missing profile straight through', () => {
    expect(sanitizeIdNumber(null)).toBeNull();
  });

  test('does not mutate the row it was given', () => {
    const row = { ...profile };
    sanitizeIdNumber(row);

    expect(row.id_number).toBe('29804181234567');
    expect(row.document_data_b64).toBe('JVBERi0xLjQK');
  });
});
