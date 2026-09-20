# NovaBank REST API surface

All authenticated endpoints use `Authorization: Bearer <session-token>`. QA mode exposes deterministic OTP/reset codes and accepts controlled fault-injection fields; these must not exist in a real banking production environment.

## Authentication
- `POST /api/auth/register`
- `POST /api/auth/verify-email`
- `POST /api/auth/login`
- `POST /api/auth/mfa`
- `POST /api/auth/logout`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/change-password`
- `GET /api/me`
- `PATCH /api/profile`

## KYC
- `GET /api/kyc`
- `POST /api/kyc`
- `GET /api/kyc/document`

## Accounts / ledger / statements
- `GET /api/accounts`
- `POST /api/accounts`
- `POST /api/accounts/:id/freeze`
- `POST /api/accounts/:id/close`
- `GET /api/accounts/:id/transactions`
- `GET /api/accounts/:id/statement`
- statement query: `from`, `to`, `format=csv`
- transaction filters: `from`, `to`, `type`, `status`, `reference`, `minAmount`, `maxAmount`

## Beneficiaries / transfers
- `GET /api/beneficiaries`
- `POST /api/beneficiaries`
- `PATCH /api/beneficiaries/:id`
- `DELETE /api/beneficiaries/:id`
- `POST /api/beneficiaries/:id/verify`
- `GET /api/transfers`
- `POST /api/transfers`

Transfer request supports own-account, same-bank and external recipients, schedule date, idempotency key, memo and a QA-only safe-failure simulation.

## Cards
- `GET /api/cards`
- `POST /api/cards`
- `POST /api/cards/:id/activate`
- `POST /api/cards/:id/freeze`
- `POST /api/cards/:id/unfreeze`
- `POST /api/cards/:id/replace`
- `POST /api/cards/:id/cancel`
- `POST /api/cards/:id/settings`

## Bills
- `GET /api/billers`
- `POST /api/billers/saved`
- `GET /api/bill-payments`
- `POST /api/bill-payments`

Supports immediate, scheduled and weekly/monthly recurring payments.

## Loans
- `GET /api/loans`
- `POST /api/loans`
- `POST /api/loans/:id/pay`

## Notifications
- `GET /api/notifications`
- `POST /api/notifications/:id/read`

## Back-office
- `GET /api/admin/dashboard`
- `GET /api/admin/customers`
- `GET /api/admin/customers/:id`
- `GET /api/admin/kyc`
- `GET /api/admin/kyc/:id/document`
- `POST /api/admin/kyc/:id/review`
- `GET /api/admin/accounts`
- `POST /api/admin/accounts/:id/freeze`
- `POST /api/admin/accounts/:id/unfreeze`
- `POST /api/admin/accounts/:id/dormant`
- `POST /api/admin/accounts/:id/activate`
- `POST /api/admin/accounts/:id/limit`
- `GET /api/admin/transfers`
- `POST /api/admin/transfers/:id/reverse`
- `GET /api/admin/loans`
- `POST /api/admin/loans/:id/review`
- `GET /api/admin/fraud`
- `PATCH /api/admin/fraud/:id`
- `GET /api/admin/audit`
- `GET /api/admin/users`
- `POST /api/admin/users/:id/role`
