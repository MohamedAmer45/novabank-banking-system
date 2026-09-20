PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'CUSTOMER',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  email_verified INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 1,
  mfa_code TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  date_of_birth TEXT,
  nationality TEXT,
  address TEXT,
  employment TEXT,
  annual_income_minor INTEGER,
  id_type TEXT,
  id_number TEXT,
  document_name TEXT,
  document_mime TEXT,
  document_data_b64 TEXT,
  reviewer_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_number TEXT NOT NULL UNIQUE,
  iban TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance_minor INTEGER NOT NULL DEFAULT 0,
  available_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  daily_limit_minor INTEGER NOT NULL DEFAULT 25000000,
  daily_transferred_minor INTEGER NOT NULL DEFAULT 0,
  daily_counter_date TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_identifier TEXT NOT NULL,
  currency TEXT NOT NULL,
  nickname TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, bank_name, account_identifier)
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  beneficiary_id INTEGER REFERENCES beneficiaries(id),
  to_account_id INTEGER REFERENCES accounts(id),
  transfer_type TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  target_currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  amount_minor INTEGER NOT NULL,
  credited_amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  memo TEXT,
  idempotency_key TEXT,
  scheduled_for TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  reversed_at TEXT,
  UNIQUE(user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  transfer_id INTEGER REFERENCES transfers(id),
  bill_payment_id INTEGER,
  loan_id INTEGER,
  transaction_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  balance_after_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  last4 TEXT NOT NULL,
  cardholder_name TEXT NOT NULL,
  card_type TEXT NOT NULL DEFAULT 'DEBIT',
  status TEXT NOT NULL DEFAULT 'PENDING_ACTIVATION',
  expiry_month INTEGER NOT NULL,
  expiry_year INTEGER NOT NULL,
  atm_enabled INTEGER NOT NULL DEFAULT 1,
  online_enabled INTEGER NOT NULL DEFAULT 1,
  international_enabled INTEGER NOT NULL DEFAULT 0,
  contactless_enabled INTEGER NOT NULL DEFAULT 1,
  atm_limit_minor INTEGER NOT NULL DEFAULT 2000000,
  purchase_limit_minor INTEGER NOT NULL DEFAULT 5000000,
  online_limit_minor INTEGER NOT NULL DEFAULT 2500000,
  created_at TEXT NOT NULL,
  replaced_by_card_id INTEGER REFERENCES cards(id),
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS billers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  customer_reference_label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_billers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  biller_id INTEGER NOT NULL REFERENCES billers(id),
  alias TEXT,
  customer_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, biller_id, customer_reference)
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  biller_id INTEGER NOT NULL REFERENCES billers(id),
  saved_biller_id INTEGER REFERENCES saved_billers(id),
  customer_reference TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TEXT,
  recurring_frequency TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  loan_type TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  interest_rate REAL NOT NULL,
  term_months INTEGER NOT NULL,
  monthly_payment_minor INTEGER NOT NULL,
  remaining_principal_minor INTEGER NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL,
  disbursement_account_id INTEGER REFERENCES accounts(id),
  applied_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT
);

CREATE TABLE IF NOT EXISTS loan_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL,
  principal_minor INTEGER NOT NULL,
  interest_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  transfer_id INTEGER REFERENCES transfers(id),
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  description TEXT NOT NULL,
  assigned_to INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  ip_address TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_created ON transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_user_created ON transfers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_status ON fraud_alerts(status, created_at DESC);
