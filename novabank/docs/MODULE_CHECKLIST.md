# Functional coverage checklist

| Module | Implemented |
|---|---|
| Registration / email verification | Yes |
| Login / logout / MFA / remember session | Yes |
| Lockout after failed logins | Yes |
| Forgot/reset/change password | Yes |
| Customer profile | Yes |
| KYC workflow + document storage/download | Yes |
| Current/savings accounts | Yes |
| EGP/USD/EUR/GBP accounts | Yes |
| Active/frozen/dormant/closed states | Yes |
| Beneficiary add/edit/delete/search/OTP verify | Yes |
| Own-account transfer | Yes |
| Same-bank transfer | Yes |
| Simulated external-bank transfer | Yes |
| FX conversion for own accounts | Yes |
| Transfer limits / balance / state validation | Yes |
| Idempotency | Yes |
| Scheduled transfer | Yes |
| Safe failure / rollback scenario | Yes |
| Transaction ledger | Yes |
| Transaction filters | Yes |
| Statements / CSV / print-to-PDF | Yes |
| Debit card request / activate / freeze / unfreeze | Yes |
| Card replace / cancel / channel controls / limits | Yes |
| Billers / saved billers | Yes |
| Immediate / scheduled / recurring bill payment | Yes |
| Personal / auto loan application | Yes |
| Loan approval/rejection/disbursement | Yes |
| Loan repayment | Yes |
| In-app / simulated email notification records | Yes |
| Admin/back-office portal | Yes |
| Role-based permissions | Yes |
| Customer/KYC/account/transfer/loan operations | Yes |
| Audit trail | Yes |
| Large-transfer fraud rule | Yes |
| Transfer-velocity fraud rule | Yes |
| Repeated-failure fraud rule | Yes |
| Unusual-country login fraud rule | Yes (QA header) |
| Fraud investigation states | Yes |
| Transfer reversal | Yes |
| Scheduled job processing | Yes |
| CI smoke suite | GitHub Actions + Jenkins |
| Docker runtime | Yes |
| PostgreSQL target schema | Yes |
