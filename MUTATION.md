# Mutation Testing

Every other measurement in this project asks whether the *application* behaves.
This one asks whether the *tests* would notice if it stopped.

Stryker changes the source — flips a `<=` to a `<`, empties a string, removes a
`.sort()` — and re-runs the unit suite. A mutant that is **killed** means a test
caught the change. A mutant that **survives** means the code was executed and
nobody checked the result.

```bash
npm run test:mutation
```

## What it found

The suite was 134 tests, all green. Mutation testing found five places where a
deliberate fault went unnoticed:

| Where | Mutation | Why it survived |
|---|---|---|
| `maskAccount` | `str.length <= 4` → `< 4` | Nothing exercised a value of exactly four characters, so an off-by-one at the boundary had nowhere to show itself |
| `maskAccount` | `str.length - 4` → `+ 4` | The assertions checked the *property* — "only the last four are legible" — which eighteen mask characters satisfy just as well as six |
| `permissionsFor` | `.sort()` removed | Every assertion used `arrayContaining` or `not.toContain`, which say nothing about order |
| `withReturningId` | `^` anchor dropped | No SQL in the suite mentioned `INSERT INTO` anywhere but the start, so nothing noticed a `SELECT` quoting those words would get `RETURNING id` appended |
| `withReturningId` | `\s+` → `\s` | Every test used exactly one space between the two words |

The second is the most interesting, because it was a deliberate choice that
backfired. Those assertions were written to check the property rather than the
exact glyphs, on the reasoning that the requirement is "nothing but the last four
is legible", not "the padding is an asterisk". That reasoning still holds — but
property assertions are robust to cosmetic change and *blind to magnitude*, and
only a mutant showed the gap between the two.

All five are fixed, each with a comment saying a mutant found it. The suite
is 141 tests now, and the seven that were added exist because a mutant
survived, not because a line was uncovered.

| File | Score before | Score after |
|---|---|---|
| `security.js` | 90.24% | **95.12%** |
| `lib/access.js` (covered) | 94.44% | **97.22%** |
| `database.js` (covered) | 73.68% | **78.95%** |

## Reading the score honestly

```text
File         |  total | covered | killed | survived | no cov |
security.js  |  95.12 |   97.50 |     39 |        1 |      1 |
access.js    |  67.31 |   97.22 |     70 |        2 |     32 |
database.js  |  26.32 |   78.95 |     30 |        8 |     76 |
banking.js   |   5.56 |   97.50 |     39 |        1 |    662 |
http.js      |   2.67 |    9.76 |      4 |       37 |    109 |
All files    |  16.38 |   78.79 |    182 |       49 |    880 |
```

**The total and the covered score answer different questions**, and only one of
them is about test quality.

*Total* counts every mutant in the file, including those in code the unit suite
never executes. `banking.js` scores 5.56% total and 97.50% covered: the handful
of pure functions the unit tests target are tested very well, and the other 662
mutants live in asynchronous database code that unit tests deliberately do not
reach. That is already known and already stated — line coverage for these files
is 17.3%, reported unscoped for the same reason.

*Covered* counts only mutants the tests actually execute. That is the number that
says whether the tests assert or merely visit.

**`http.js` deserves the caveat it looks like it needs least.** 37 survivors, a
9.76% covered score — the worst number in the table. Nearly all of those mutants
are in the `SECURITY_HEADERS` constant, which is evaluated when the module is
imported, so Stryker counts it as covered. No Jest test asserts its contents,
because those headers are asserted by `SecurityHeadersTest` in the REST Assured
suite, against a running server, which Stryker never starts.

So the score attributes to the unit suite a fault that another suite does catch.
Changing `'nosniff'` to `""` would fail CI — just not here. A mutation score is
scoped to the tests it runs, and reading it as "these faults are undetected"
would be wrong.

## Why the remaining three survivors are left alone

They are **equivalent mutants**: they change the source without changing any
observable behaviour, so no test can kill them.

```js
const header = req.headers.authorization || '';        // → || "Stryker was here!"
const granted = ROLE_PERMISSIONS[user.role] || [];     // → || ["Stryker was here"]
if (!stored || !stored.includes(':')) return false;    // → !stored.includes("")
```

A header that is absent fails `startsWith('Bearer ')` whatever the fallback is.
An unknown role holds neither the wildcard nor the requested permission whatever
the empty array contains. And the `':'` guard is redundant given the `try/catch`
below it — malformed input returns `false` either way.

A 100% mutation score is not the goal. Equivalent mutants are unkillable by
definition, and chasing them produces tests that assert implementation detail
instead of behaviour, which is a worse suite than the one you started with.

## Why this is reported and not gated

The total score is dominated by mutants in code the unit suite deliberately does
not target, so a threshold on it would measure *scope* rather than *quality* —
it would move whenever someone added a function, regardless of whether the tests
got better or worse.

The same reasoning applies here as to line coverage, which is also reported
unscoped and gated on nothing. What is gated in this project is correctness:
the ledger invariant, the concurrent-debit contract, the security headers, the
accessibility scan. Those hold or they do not.

CI runs it on every push and prints the covered score as an annotation:

```text
mutation score 78.8% of covered mutants (182 killed, 49 survived, 880 not reached);
banking.js 97.5%; database.js 78.9%; access.js 97.2%; http.js 9.8%; security.js 97.5%
```

The full HTML report is uploaded as the `mutation-report` artifact. The step
fails only if Stryker itself fails; no score fails the build.

The honest use of this number is as a check on the unit suite when it changes,
read with the table above in mind. The whole run takes about 13 seconds, which
is the only reason it can sit in CI at all — 1,111 mutants against a suite that
finishes in under a second.
