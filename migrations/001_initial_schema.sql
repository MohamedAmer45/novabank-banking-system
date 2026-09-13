-- ============================================================
-- NOVABANK INITIAL DATABASE SCHEMA
-- ============================================================


-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,

    email VARCHAR(320) NOT NULL,
    password_hash TEXT NOT NULL,

    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),

    role VARCHAR(30) NOT NULL DEFAULT 'CUSTOMER'
        CHECK (
            role IN (
                'CUSTOMER',
                'SUPPORT',
                'AUDITOR',
                'EMPLOYEE',
                'MANAGER',
                'ADMIN'
            )
        ),

    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'
        CHECK (
            status IN (
                'ACTIVE',
                'LOCKED',
                'SUSPENDED',
                'DISABLED'
            )
        ),

    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,

    password_changed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower
    ON users (LOWER(email));


-- ------------------------------------------------------------
-- KYC
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kyc_profiles (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL UNIQUE
        REFERENCES users(id)
        ON DELETE CASCADE,

    status VARCHAR(40) NOT NULL DEFAULT 'NOT_STARTED'
        CHECK (
            status IN (
                'NOT_STARTED',
                'SUBMITTED',
                'UNDER_REVIEW',
                'VERIFIED',
                'NEEDS_MORE_INFORMATION',
                'REJECTED',
                'SUSPENDED'
            )
        ),

    date_of_birth DATE,
    nationality VARCHAR(100),
    address TEXT,
    employment VARCHAR(200),

    annual_income_minor BIGINT,

    id_type VARCHAR(50),
    id_number VARCHAR(150),

    document_name VARCHAR(255),
    document_mime VARCHAR(150),
    document_data BYTEA,

    reviewer_note TEXT,

    reviewed_by BIGINT
        REFERENCES users(id)
        ON DELETE SET NULL,

    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ------------------------------------------------------------
-- BANK ACCOUNTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    account_number VARCHAR(50) NOT NULL UNIQUE,
    iban VARCHAR(100) NOT NULL UNIQUE,

    account_type VARCHAR(30) NOT NULL
        CHECK (
            account_type IN (
                'CURRENT',
                'SAVINGS'
            )
        ),

    currency VARCHAR(3) NOT NULL
        CHECK (
            currency IN (
                'EGP',
                'USD',
                'EUR',
                'GBP'
            )
        ),

    balance_minor BIGINT NOT NULL DEFAULT 0,

    daily_limit_minor BIGINT NOT NULL DEFAULT 5000000,

    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'
        CHECK (
            status IN (
                'ACTIVE',
                'FROZEN',
                'DORMANT',
                'CLOSED'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_accounts_user
    ON accounts(user_id);


CREATE INDEX IF NOT EXISTS ix_accounts_status
    ON accounts(status);


-- ------------------------------------------------------------
-- BENEFICIARIES
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS beneficiaries (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    name VARCHAR(200) NOT NULL,
    nickname VARCHAR(150),

    bank_name VARCHAR(200) NOT NULL,
    account_identifier VARCHAR(150) NOT NULL,

    currency VARCHAR(3) NOT NULL
        CHECK (
            currency IN (
                'EGP',
                'USD',
                'EUR',
                'GBP'
            )
        ),

    verified BOOLEAN NOT NULL DEFAULT FALSE,

    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_beneficiaries_user
    ON beneficiaries(user_id);


-- ------------------------------------------------------------
-- TRANSFERS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transfers (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    from_account_id BIGINT NOT NULL
        REFERENCES accounts(id),

    to_account_id BIGINT
        REFERENCES accounts(id),

    beneficiary_id BIGINT
        REFERENCES beneficiaries(id),

    reference VARCHAR(100) NOT NULL UNIQUE,

    transfer_type VARCHAR(50) NOT NULL
        CHECK (
            transfer_type IN (
                'OWN_ACCOUNT',
                'SAME_BANK',
                'EXTERNAL'
            )
        ),

    amount_minor BIGINT NOT NULL
        CHECK (amount_minor > 0),

    fee_minor BIGINT NOT NULL DEFAULT 0,

    source_currency VARCHAR(3) NOT NULL,

    memo VARCHAR(80),

    status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'SCHEDULED',
                'PROCESSING',
                'COMPLETED',
                'FAILED',
                'CANCELLED',
                'REVERSED'
            )
        ),

    scheduled_for TIMESTAMPTZ,

    idempotency_key VARCHAR(200),

    qa_simulation VARCHAR(50),

    failure_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE UNIQUE INDEX IF NOT EXISTS ux_transfers_user_idempotency
    ON transfers(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;


CREATE INDEX IF NOT EXISTS ix_transfers_user
    ON transfers(user_id);


CREATE INDEX IF NOT EXISTS ix_transfers_from_account
    ON transfers(from_account_id);


CREATE INDEX IF NOT EXISTS ix_transfers_status
    ON transfers(status);


-- ------------------------------------------------------------
-- CARDS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cards (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    account_id BIGINT NOT NULL
        REFERENCES accounts(id),

    last4 VARCHAR(4) NOT NULL,

    cardholder_name VARCHAR(200) NOT NULL,

    expiry_month INTEGER NOT NULL
        CHECK (expiry_month BETWEEN 1 AND 12),

    expiry_year INTEGER NOT NULL,

    status VARCHAR(40) NOT NULL DEFAULT 'PENDING_ACTIVATION'
        CHECK (
            status IN (
                'PENDING_ACTIVATION',
                'ACTIVE',
                'FROZEN',
                'CANCELLED',
                'REPLACED'
            )
        ),

    atm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    online_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    international_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    contactless_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    atm_limit_minor BIGINT NOT NULL DEFAULT 500000,
    purchase_limit_minor BIGINT NOT NULL DEFAULT 1500000,
    online_limit_minor BIGINT NOT NULL DEFAULT 1000000,

    replaced_by_card_id BIGINT
        REFERENCES cards(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_cards_user
    ON cards(user_id);


CREATE INDEX IF NOT EXISTS ix_cards_account
    ON cards(account_id);


-- ------------------------------------------------------------
-- BILLERS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billers (
    id BIGSERIAL PRIMARY KEY,

    name VARCHAR(200) NOT NULL,
    category VARCHAR(100) NOT NULL,

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ------------------------------------------------------------
-- SAVED BILLERS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS saved_billers (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    biller_id BIGINT NOT NULL
        REFERENCES billers(id),

    alias VARCHAR(200),

    customer_reference VARCHAR(200) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_saved_billers_user
    ON saved_billers(user_id);


-- ------------------------------------------------------------
-- BILL PAYMENTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bill_payments (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    account_id BIGINT NOT NULL
        REFERENCES accounts(id),

    biller_id BIGINT NOT NULL
        REFERENCES billers(id),

    reference VARCHAR(100) NOT NULL UNIQUE,

    customer_reference VARCHAR(200) NOT NULL,

    amount_minor BIGINT NOT NULL
        CHECK (amount_minor > 0),

    status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'SCHEDULED',
                'PROCESSING',
                'COMPLETED',
                'FAILED',
                'CANCELLED'
            )
        ),

    scheduled_for TIMESTAMPTZ,

    recurring_frequency VARCHAR(20)
        CHECK (
            recurring_frequency IS NULL
            OR recurring_frequency IN (
                'WEEKLY',
                'MONTHLY'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_bill_payments_user
    ON bill_payments(user_id);


-- ------------------------------------------------------------
-- LOANS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loans (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    disbursement_account_id BIGINT NOT NULL
        REFERENCES accounts(id),

    loan_type VARCHAR(30) NOT NULL
        CHECK (
            loan_type IN (
                'PERSONAL',
                'AUTO'
            )
        ),

    amount_minor BIGINT NOT NULL
        CHECK (amount_minor > 0),

    interest_rate NUMERIC(8,4) NOT NULL,

    term_months INTEGER NOT NULL
        CHECK (term_months > 0),

    monthly_payment_minor BIGINT NOT NULL DEFAULT 0,

    remaining_principal_minor BIGINT NOT NULL DEFAULT 0,

    purpose TEXT,

    status VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED'
        CHECK (
            status IN (
                'SUBMITTED',
                'UNDER_REVIEW',
                'APPROVED',
                'REJECTED',
                'ACTIVE',
                'PAID',
                'DEFAULTED'
            )
        ),

    underwriter_note TEXT,

    reviewed_by BIGINT
        REFERENCES users(id)
        ON DELETE SET NULL,

    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_loans_user
    ON loans(user_id);


CREATE INDEX IF NOT EXISTS ix_loans_status
    ON loans(status);


-- ------------------------------------------------------------
-- LEDGER / TRANSACTIONS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    account_id BIGINT NOT NULL
        REFERENCES accounts(id),

    transfer_id BIGINT
        REFERENCES transfers(id)
        ON DELETE SET NULL,

    bill_payment_id BIGINT
        REFERENCES bill_payments(id)
        ON DELETE SET NULL,

    loan_id BIGINT
        REFERENCES loans(id)
        ON DELETE SET NULL,

    reference VARCHAR(100) NOT NULL,

    transaction_type VARCHAR(50) NOT NULL
        CHECK (
            transaction_type IN (
                'TRANSFER',
                'DEPOSIT',
                'BILL_PAYMENT',
                'LOAN_DISBURSEMENT',
                'LOAN_PAYMENT',
                'REVERSAL'
            )
        ),

    description TEXT NOT NULL,

    direction VARCHAR(10) NOT NULL
        CHECK (
            direction IN (
                'DEBIT',
                'CREDIT'
            )
        ),

    amount_minor BIGINT NOT NULL
        CHECK (amount_minor >= 0),

    fee_minor BIGINT NOT NULL DEFAULT 0,

    balance_after_minor BIGINT NOT NULL,

    currency VARCHAR(3) NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_transactions_account_created
    ON transactions(account_id, created_at DESC);


CREATE INDEX IF NOT EXISTS ix_transactions_user
    ON transactions(user_id);


CREATE INDEX IF NOT EXISTS ix_transactions_reference
    ON transactions(reference);


-- ------------------------------------------------------------
-- NOTIFICATIONS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,

    channel VARCHAR(30) NOT NULL DEFAULT 'IN_APP'
        CHECK (
            channel IN (
                'IN_APP',
                'EMAIL',
                'SMS'
            )
        ),

    read_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_notifications_user_created
    ON notifications(user_id, created_at DESC);


-- ------------------------------------------------------------
-- FRAUD ALERTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fraud_alerts (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT
        REFERENCES users(id)
        ON DELETE SET NULL,

    transfer_id BIGINT
        REFERENCES transfers(id)
        ON DELETE SET NULL,

    rule_code VARCHAR(100) NOT NULL,

    severity VARCHAR(20) NOT NULL
        CHECK (
            severity IN (
                'LOW',
                'MEDIUM',
                'HIGH',
                'CRITICAL'
            )
        ),

    description TEXT NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'OPEN'
        CHECK (
            status IN (
                'OPEN',
                'INVESTIGATING',
                'CLEARED',
                'CONFIRMED'
            )
        ),

    resolution_note TEXT,

    reviewed_by BIGINT
        REFERENCES users(id)
        ON DELETE SET NULL,

    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_fraud_alerts_status
    ON fraud_alerts(status);


-- ------------------------------------------------------------
-- AUDIT LOG
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,

    actor_user_id BIGINT
        REFERENCES users(id)
        ON DELETE SET NULL,

    action VARCHAR(150) NOT NULL,

    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100),

    result VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',

    ip_address VARCHAR(100),

    metadata_json JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS ix_audit_logs_created
    ON audit_logs(created_at DESC);


CREATE INDEX IF NOT EXISTS ix_audit_logs_actor
    ON audit_logs(actor_user_id);


CREATE INDEX IF NOT EXISTS ix_audit_logs_action
    ON audit_logs(action);


-- ------------------------------------------------------------
-- UPDATED_AT HELPER
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- USERS

DROP TRIGGER IF EXISTS trg_users_updated_at
ON users;

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- KYC

DROP TRIGGER IF EXISTS trg_kyc_updated_at
ON kyc_profiles;

CREATE TRIGGER trg_kyc_updated_at
BEFORE UPDATE ON kyc_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ACCOUNTS

DROP TRIGGER IF EXISTS trg_accounts_updated_at
ON accounts;

CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- BENEFICIARIES

DROP TRIGGER IF EXISTS trg_beneficiaries_updated_at
ON beneficiaries;

CREATE TRIGGER trg_beneficiaries_updated_at
BEFORE UPDATE ON beneficiaries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- TRANSFERS

DROP TRIGGER IF EXISTS trg_transfers_updated_at
ON transfers;

CREATE TRIGGER trg_transfers_updated_at
BEFORE UPDATE ON transfers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- CARDS

DROP TRIGGER IF EXISTS trg_cards_updated_at
ON cards;

CREATE TRIGGER trg_cards_updated_at
BEFORE UPDATE ON cards
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- SAVED BILLERS

DROP TRIGGER IF EXISTS trg_saved_billers_updated_at
ON saved_billers;

CREATE TRIGGER trg_saved_billers_updated_at
BEFORE UPDATE ON saved_billers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- BILL PAYMENTS

DROP TRIGGER IF EXISTS trg_bill_payments_updated_at
ON bill_payments;

CREATE TRIGGER trg_bill_payments_updated_at
BEFORE UPDATE ON bill_payments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- LOANS

DROP TRIGGER IF EXISTS trg_loans_updated_at
ON loans;

CREATE TRIGGER trg_loans_updated_at
BEFORE UPDATE ON loans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- FRAUD

DROP TRIGGER IF EXISTS trg_fraud_updated_at
ON fraud_alerts;

CREATE TRIGGER trg_fraud_updated_at
BEFORE UPDATE ON fraud_alerts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
