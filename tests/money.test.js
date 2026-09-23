import { describe, test, expect } from '@jest/globals';

import { FX, convertMinor, calculateLoanPayment, nextRecurringDate } from '../src/banking.js';
import { moneyMinor } from '../src/lib/http.js';

describe('moneyMinor', () => {
  test('converts major units to integer minor units', () => {
    expect(moneyMinor(12.34)).toBe(1234);
    expect(moneyMinor(100)).toBe(10000);
    expect(moneyMinor(0.01)).toBe(1);
  });

  test('accepts a numeric string, as it arrives from a form', () => {
    expect(moneyMinor('12.34')).toBe(1234);
  });

  test.each([
    [2.675, 268],
    [0.615, 62],
    [19.99, 1999],
    [1234.56, 123456]
  ])('rounds %p to %i minor units', (major, expected) => {
    expect(moneyMinor(major)).toBe(expected);
  });

  /*
   * A documented boundary rather than an aspiration.
   *
   * moneyMinor is Math.round(value * 100), so a third decimal whose binary
   * representation falls just below the halfway point rounds down where
   * decimal arithmetic would round up: 1.005 * 100 is 100.49999999999999 and
   * 8.165 * 100 is 816.4999999999999.
   *
   * This is reachable only with a sub-cent input. The transfer form uses
   * step="0.01" and currency has two decimal places, so no legitimate client
   * submits three. It is asserted here so the behaviour is known and a future
   * change to the rounding strategy is a deliberate decision rather than an
   * accident.
   */
  test.each([
    [1.005, 100],
    [8.165, 816]
  ])('truncates the sub-cent input %p to %i, a float-representation boundary', (major, expected) => {
    expect(moneyMinor(major)).toBe(expected);
  });

  test('always returns an integer', () => {
    const awkward = [0.1, 0.2, 0.3, 1.1, 2.2, 3.3, 19.99, 1234.56];

    awkward.forEach(value => {
      expect(Number.isInteger(moneyMinor(value))).toBe(true);
    });
  });

  test('returns NaN for a value that is not a number', () => {
    // The callers check for this; silently coercing to 0 would turn a typo
    // into a free transfer.
    expect(Number.isNaN(moneyMinor('abc'))).toBe(true);
    expect(Number.isNaN(moneyMinor(undefined))).toBe(true);
    expect(Number.isNaN(moneyMinor(null))).toBe(false); // Number(null) is 0
  });

  test('handles a large amount without losing precision', () => {
    expect(moneyMinor(250000)).toBe(25000000);
  });
});

describe('convertMinor', () => {
  test('is a no-op between the same currency', () => {
    expect(convertMinor(10000, 'EGP', 'EGP')).toEqual({ rate: 1, amount: 10000 });
  });

  test('converts EGP to USD at the published rate', () => {
    const { rate, amount } = convertMinor(10000, 'EGP', 'USD');

    expect(rate).toBeCloseTo(1 / FX.USD, 10);
    expect(amount).toBe(Math.round(10000 / FX.USD));
  });

  test('converts USD to EGP at the inverse', () => {
    const { amount } = convertMinor(100, 'USD', 'EGP');

    expect(amount).toBe(Math.round(100 * FX.USD));
  });

  test('always returns an integer amount', () => {
    for (const target of ['USD', 'EUR', 'GBP']) {
      const { amount } = convertMinor(12345, 'EGP', target);
      expect(Number.isInteger(amount)).toBe(true);
    }
  });

  /*
   * The recorded rate has to reproduce the credited amount, or a statement
   * recomputed from it will not reconcile. This is the property BUG-DB-001
   * broke by storing the rate as a single-precision float.
   */
  test('the returned rate reproduces the returned amount', () => {
    for (const target of ['USD', 'EUR', 'GBP']) {
      const { rate, amount } = convertMinor(100000, 'EGP', target);
      expect(Math.round(100000 * rate)).toBe(amount);
    }
  });

  test('a round trip stays within a rounding unit', () => {
    const out = convertMinor(1000000, 'EGP', 'USD');
    const back = convertMinor(out.amount, 'USD', 'EGP');

    // Not exactly equal: rounding to whole cents on the way out loses a
    // fraction, which is correct and unavoidable. What matters is the loss
    // being bounded rather than compounding.
    expect(Math.abs(back.amount - 1000000)).toBeLessThan(FX.USD * 2);
  });

  test('converting zero yields zero', () => {
    expect(convertMinor(0, 'EGP', 'USD').amount).toBe(0);
  });
});

describe('calculateLoanPayment', () => {
  test('matches the standard amortisation formula', () => {
    const principal = 5_000_000;
    const annualRate = 18;
    const months = 24;

    const r = annualRate / 100 / 12;
    const expected = Math.round(
      principal * r * (1 + r) ** months / ((1 + r) ** months - 1)
    );

    expect(calculateLoanPayment(principal, annualRate, months)).toBe(expected);
  });

  test('divides evenly when the rate is zero', () => {
    // The formula divides by zero at r = 0, so the implementation must branch.
    expect(calculateLoanPayment(1_200_000, 0, 12)).toBe(100_000);
  });

  test('total repayment exceeds the principal when interest is charged', () => {
    const principal = 5_000_000;
    const monthly = calculateLoanPayment(principal, 18, 24);

    expect(monthly * 24).toBeGreaterThan(principal);
  });

  test('a longer term lowers the monthly payment but raises the total', () => {
    const principal = 5_000_000;

    const short = calculateLoanPayment(principal, 18, 12);
    const long = calculateLoanPayment(principal, 18, 60);

    expect(long).toBeLessThan(short);
    expect(long * 60).toBeGreaterThan(short * 12);
  });

  test('a higher rate raises the payment', () => {
    expect(calculateLoanPayment(5_000_000, 18, 24))
      .toBeGreaterThan(calculateLoanPayment(5_000_000, 15.5, 24));
  });

  test('always returns whole minor units', () => {
    for (const months of [12, 24, 36, 48, 60]) {
      expect(Number.isInteger(calculateLoanPayment(5_000_000, 18, months))).toBe(true);
    }
  });

  test('a single-month term repays principal plus one period of interest', () => {
    const principal = 1_000_000;
    const monthly = calculateLoanPayment(principal, 12, 1);

    // One month at 12% annual is 1% interest.
    expect(monthly).toBe(Math.round(principal * 1.01));
  });
});

describe('nextRecurringDate', () => {
  test('a weekly recurrence lands seven days out', () => {
    const next = new Date(nextRecurringDate('WEEKLY')).getTime();
    const expected = Date.now() + 7 * 24 * 3600 * 1000;

    expect(Math.abs(next - expected)).toBeLessThan(5000);
  });

  test('a monthly recurrence lands in the following month', () => {
    const next = new Date(nextRecurringDate('MONTHLY'));
    const now = new Date();

    const monthsApart =
      (next.getUTCFullYear() - now.getUTCFullYear()) * 12 +
      (next.getUTCMonth() - now.getUTCMonth());

    expect(monthsApart).toBe(1);
  });

  test('an unknown frequency produces no next date', () => {
    // Returning a date for a frequency the caller did not ask for would
    // schedule a payment nobody authorised.
    expect(nextRecurringDate('FORTNIGHTLY')).toBeNull();
    expect(nextRecurringDate(null)).toBeNull();
    expect(nextRecurringDate('')).toBeNull();
  });

  test('returns ISO-8601, matching how scheduled_for is compared', () => {
    expect(nextRecurringDate('MONTHLY')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('the FX table', () => {
  test('EGP is the base', () => {
    expect(FX.EGP).toBe(1);
  });

  test('every supported currency has a positive rate', () => {
    ['EGP', 'USD', 'EUR', 'GBP'].forEach(currency => {
      expect(FX[currency]).toBeGreaterThan(0);
    });
  });
});
