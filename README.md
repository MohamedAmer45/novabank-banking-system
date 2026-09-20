# NovaBank

A simulated retail banking application. It exists to be tested: the QA project
that exercises it lives separately in
[`qa-banking-system`](https://github.com/MohamedAmer45/qa-banking-system).

Live: https://novabank-banking-system.vercel.app

No real money, cards, or banking networks are involved.

## Stack

| | |
|---|---|
| Frontend | Static HTML/CSS/JavaScript single-page app, no build step |
| Backend | Node.js 22+, no framework — `node:http` and a route table |
| Database | PostgreSQL (Neon in the hosted environment) |
| Auth | Opaque session tokens in a `sessions` table, plus an MFA challenge step |
| Hosting | Vercel serverless (`api/index.js`), same handler as the local server |

Only two runtime dependencies: `pg` and `dotenv`.

## Running it

```bash
npm install
cp .env.example .env          # then set DATABASE_URL
npm run db:migrate            # create the 17 tables
npm run db:seed               # load the QA fixtures
npm start                     # http://localhost:3000
```

Any PostgreSQL 14+ instance works — Neon, Supabase, the bundled
`docker-compose.yml`, or a CI service container. Set `DATABASE_SSL=false` for a
local instance without TLS.

### Database commands

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply `database/postgres-schema.sql` (idempotent) |
| `npm run db:migrate -- --reset` | Drop this app's tables, then apply the schema |
| `npm run db:seed` | Load QA fixtures; refuses if data exists unless `--force` |
| `npm run db:reset` | Reset and reseed in one step |
| `npm run db:check` | Connectivity, table presence, row counts, ledger invariant |

`db:check` verifies that every account balance equals the `balance_after_minor`
of its most recent transaction. A mismatch means a money movement updated one
without the other, which is the failure mode worth catching early.

## Test accounts

Every seeded user has MFA enabled. The code is always `123456`.

| Email | Password | Role | Notes |
|---|---|---|---|
| `customer@novabank.test` | `Demo123!` | CUSTOMER | KYC verified, 3 accounts, card, loan awaiting review |
| `receiver@novabank.test` | `Demo123!` | CUSTOMER | Destination for same-bank transfers |
| `pending@novabank.test` | `Demo123!` | CUSTOMER | KYC under review |
| `admin@novabank.test` | `Admin123!` | ADMIN | All permissions |
| `manager@novabank.test` | `Manager123!` | MANAGER | Reversals, limits, loan and KYC review |
| `support@novabank.test` | `Support123!` | SUPPORT | Read-only customer/account/transfer access |
| `auditor@novabank.test` | `Auditor123!` | AUDITOR | Read-only plus audit and fraud |
| `employee@novabank.test` | `Employee123!` | EMPLOYEE | Read-only plus KYC review |

## QA mode

With `QA_MODE=true` the API returns values a real bank would deliver out of
band, so tests do not need a mail server:

- `POST /api/auth/login` returns `demoCode` — the MFA code
- `POST /api/auth/register` returns `demoVerificationCode`
- `POST /api/auth/forgot-password` returns `demoResetToken`
- `POST /api/beneficiaries` returns `demoOtp`
- `POST /api/transfers` accepts `qaSimulation: "failure"` to force a safe,
  non-debiting failure
- The `X-QA-Country` header drives the unusual-login fraud rule

Set it to `false` and all of those disappear.

## Layout

```
api/index.js              Vercel entry point
server.js                 Local and CI entry point
src/app.js                Route table, static serving, error handling
src/banking.js            Money movement: transfers, bills, loans, fraud rules
src/database.js           PostgreSQL pool, transactions, query helpers
src/security.js           Password hashing, tokens, time helpers
src/routes/               Request handlers by domain
src/lib/                  HTTP plumbing and access control
database/                 PostgreSQL schema (+ the SQLite original, for reference)
scripts/                  migrate, seed, db-check, smoke
public/                   The single-page app
docs/                     API surface, architecture, coverage checklist
```

## Documentation

- [`docs/API.md`](docs/API.md) — every endpoint
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — invariants and how money moves
- [`docs/MODULE_CHECKLIST.md`](docs/MODULE_CHECKLIST.md) — what is implemented
