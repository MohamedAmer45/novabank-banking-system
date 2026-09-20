# NovaBank QA Lab

A fully functioning **simulated retail banking system** built as a Software Quality Engineering portfolio target. It includes a customer banking portal, role-controlled back-office portal, REST API, relational ledger, transaction-safe money movement, scheduled jobs, fraud rules, audit logs and deterministic QA failure paths.

> **Important:** NovaBank is a testing environment. It does not connect to real banking networks, real cards, real identity providers or real money.

## Run it

Requirements: **Node.js 22.5+**. There are no npm dependencies in the runnable edition.

```bash
cd novabank
npm start
```

Open:

```text
http://localhost:3000
```

Run the end-to-end API/ledger smoke suite while the server is running:

```bash
npm run smoke
```

Reset all data back to the seed state (stop the server first):

```bash
npm run reset
```

Docker is also supported:

```bash
docker compose up --build
```

## Seeded QA accounts

All seeded accounts use MFA code **123456**.

| Role | Email | Password |
|---|---|---|
| Customer | `customer@novabank.test` | `Demo123!` |
| Receiver/customer | `receiver@novabank.test` | `Demo123!` |
| Pending-KYC customer | `pending@novabank.test` | `Demo123!` |
| Admin | `admin@novabank.test` | `Admin123!` |
| Manager | `manager@novabank.test` | `Manager123!` |
| Employee | `employee@novabank.test` | `Employee123!` |
| Support | `support@novabank.test` | `Support123!` |
| Auditor | `auditor@novabank.test` | `Auditor123!` |

## Customer modules

- Registration and email verification
- Login, logout, MFA and remembered sessions
- Failed-login lockout
- Forgot/reset/change password
- Profile management
- KYC workflow and identity document upload/download
- Current and savings accounts
- EGP, USD, EUR and GBP account currencies
- Active, frozen, dormant and closed account states
- Beneficiary add/edit/delete/search + OTP verification
- Own-account transfers
- Same-bank transfers
- Simulated external-bank transfers
- Static FX conversion for own-account transfers
- Daily transfer limits
- Idempotent transfer submission
- Scheduled transfers
- Controlled external-transfer failure with safe rollback
- Ledger transaction history with filters
- Monthly/custom statements
- CSV export and browser Print/PDF
- Debit-card request/activation/freeze/unfreeze/replacement/cancellation
- ATM, online, international and contactless controls
- Card limits
- Saved billers
- Immediate, scheduled and recurring bill payments
- Personal and auto loan applications
- Loan repayment
- In-app + simulated email/SMS notification records

## Back-office modules

- Operations dashboard
- Customer search/inspection
- KYC review: verified/rejected/more-info/suspended
- Account freeze/unfreeze/dormant/activate
- Transfer-limit management
- Transfer review and reversal
- Loan underwriting and disbursement
- Fraud alert review
- Searchable append-only audit trail
- User/role management
- Server-side RBAC for Support, Auditor, Employee, Manager and Admin

## Fraud / risk rules

The application can create alerts for:

- Transfers at/above the configured **100,000 EGP-equivalent** threshold
- Five or more transfers within one minute
- Repeated failed transfers
- QA-simulated login from a country other than Egypt

To exercise the last rule directly through the API, send `x-qa-country: US` (or another non-EG value) on the MFA verification request.

## Banking invariants intentionally built for testing

- Account balances are stored as integer minor units.
- Debit/credit operations are enclosed in database transactions.
- A failed external transfer leaves the customer's balance unchanged.
- Same-bank transfers create both debit and credit ledger rows.
- Daily limits are enforced before debit.
- Frozen/dormant/closed source accounts cannot transfer.
- Transfer idempotency keys prevent accidental duplicate creation.
- Reversals create compensating entries instead of deleting financial history.
- Sensitive staff operations create audit records.
- Authorization is checked by the backend, not only by hidden UI controls.

## Database

The downloadable runnable edition uses **Node 22's built-in SQLite driver** so you can launch the whole application without downloading framework dependencies. This is still a relational SQL database and is useful immediately for learning SQL validation.

The project also includes `database/postgres-schema.sql`, which mirrors the model and is the target for the dedicated **PostgreSQL + DBeaver + JDBC + Testcontainers** phase we planned. Moving to PostgreSQL is a persistence-layer task; the UI/API business workflows do not need to be redesigned.

Core tables include:

`users`, `sessions`, `verification_tokens`, `kyc_profiles`, `accounts`, `beneficiaries`, `transfers`, `transactions`, `cards`, `billers`, `saved_billers`, `bill_payments`, `loans`, `loan_payments`, `notifications`, `fraud_alerts`, `audit_logs`.

## QA fault injection

The transfer form contains a QA-only external-network failure option. It deliberately creates a transfer failure while proving that the debit is rolled back. The REST endpoint supports the same controlled behavior via `qaSimulation: "failure"` when QA mode is enabled.

This is preferable to random defects because tests can reproduce the same failure deterministically.

## CI/CD already included

- `.github/workflows/ci.yml`
- `Jenkinsfile`
- `Dockerfile`
- `docker-compose.yml`

The current CI pipeline performs syntax validation, starts NovaBank and executes the banking smoke suite. As we implement Playwright, Selenium, Cypress, REST Assured, Cucumber, JMeter, k6, ZAP, Pact and the database suites, they can be added as separate pipeline stages.

## Documentation

- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/MODULE_CHECKLIST.md`
- `qa/README.md`
- `database/sqlite-schema.sql`
- `database/postgres-schema.sql`

## Next QA phases

The `qa/` directory intentionally does **not** contain fake placeholder tests. We will build actual traceable suites against this application using:

- Playwright + TypeScript
- Selenium + Java + TestNG
- Cypress + TypeScript
- Postman
- REST Assured + Java
- PostgreSQL/DBeaver/JDBC/Testcontainers
- Cucumber
- JMeter + Grafana/InfluxDB
- k6
- OWASP ZAP
- Pact
- WireMock
- axe-core
- Allure
- GitHub Actions + Jenkins
