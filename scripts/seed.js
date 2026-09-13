require("dotenv").config();

const bcrypt =
    require("bcryptjs");

const {
    getPool
} = require("../src/db/database");


const customerPassword =
    process.env.SEED_CUSTOMER_PASSWORD;

const staffPassword =
    process.env.SEED_STAFF_PASSWORD;


if (!customerPassword) {
    throw new Error(
        "SEED_CUSTOMER_PASSWORD is not configured."
    );
}

if (!staffPassword) {
    throw new Error(
        "SEED_STAFF_PASSWORD is not configured."
    );
}


async function seed() {

    const pool =
        getPool();

    if (!pool) {
        throw new Error(
            "DATABASE_URL is not configured."
        );
    }


    const client =
        await pool.connect();


    try {

        console.log("");
        console.log("Starting NovaBank QA seed...");
        console.log("");

        await client.query(
            "BEGIN"
        );


        // ====================================================
        // PASSWORD HASHES
        // ====================================================

        const customerHash =
            await bcrypt.hash(
                customerPassword,
                12
            );

        const staffHash =
            await bcrypt.hash(
                staffPassword,
                12
            );


        // ====================================================
        // USERS
        // ====================================================

        const users = [
            {
                email: "customer@novabank.test",
                firstName: "QA",
                lastName: "Customer",
                role: "CUSTOMER",
                passwordHash: customerHash
            },
            {
                email: "admin@novabank.test",
                firstName: "QA",
                lastName: "Admin",
                role: "ADMIN",
                passwordHash: staffHash
            },
            {
                email: "manager@novabank.test",
                firstName: "QA",
                lastName: "Manager",
                role: "MANAGER",
                passwordHash: staffHash
            },
            {
                email: "employee@novabank.test",
                firstName: "QA",
                lastName: "Employee",
                role: "EMPLOYEE",
                passwordHash: staffHash
            },
            {
                email: "support@novabank.test",
                firstName: "QA",
                lastName: "Support",
                role: "SUPPORT",
                passwordHash: staffHash
            },
            {
                email: "auditor@novabank.test",
                firstName: "QA",
                lastName: "Auditor",
                role: "AUDITOR",
                passwordHash: staffHash
            }
        ];


        const userIds = {};


        for (const user of users) {

            const result =
                await client.query(
                    `
                    INSERT INTO users (
                        email,
                        password_hash,
                        first_name,
                        last_name,
                        role,
                        status,
                        email_verified,
                        mfa_enabled,
                        password_changed_at
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        'ACTIVE',
                        TRUE,
                        TRUE,
                        NOW()
                    )
                    ON CONFLICT (
                        LOWER(email)
                    )
                    DO UPDATE SET
                        password_hash =
                            EXCLUDED.password_hash,
                        first_name =
                            EXCLUDED.first_name,
                        last_name =
                            EXCLUDED.last_name,
                        role =
                            EXCLUDED.role,
                        status =
                            'ACTIVE',
                        email_verified =
                            TRUE,
                        mfa_enabled =
                            TRUE,
                        failed_login_attempts =
                            0,
                        locked_until =
                            NULL
                    RETURNING id
                    `,
                    [
                        user.email,
                        user.passwordHash,
                        user.firstName,
                        user.lastName,
                        user.role
                    ]
                );


            userIds[user.email] =
                result.rows[0].id;
        }


        const customerId =
            userIds["customer@novabank.test"];

        const adminId =
            userIds["admin@novabank.test"];


        // ====================================================
        // KYC
        // ====================================================

        await client.query(
            `
            INSERT INTO kyc_profiles (
                user_id,
                status,
                date_of_birth,
                nationality,
                address,
                employment,
                annual_income_minor,
                id_type,
                id_number,
                reviewer_note,
                reviewed_by,
                reviewed_at
            )
            VALUES (
                $1,
                'VERIFIED',
                DATE '1999-01-15',
                'Egyptian',
                'Cairo, Egypt',
                'Software Quality Engineer',
                60000000,
                'NATIONAL_ID',
                'QA-NATIONAL-ID-001',
                'Verified QA seed profile.',
                $2,
                NOW()
            )
            ON CONFLICT (user_id)
            DO UPDATE SET
                status = 'VERIFIED',
                nationality = EXCLUDED.nationality,
                address = EXCLUDED.address,
                employment = EXCLUDED.employment,
                annual_income_minor =
                    EXCLUDED.annual_income_minor,
                reviewer_note =
                    EXCLUDED.reviewer_note,
                reviewed_by =
                    EXCLUDED.reviewed_by,
                reviewed_at =
                    NOW()
            `,
            [
                customerId,
                adminId
            ]
        );


        // ====================================================
        // ACCOUNTS
        //
        // Monetary values are stored in minor units.
        //
        // 25000000 = 250,000.00 EGP
        // ====================================================

        const accountSeeds = [
            {
                accountNumber:
                    "QA-CURRENT-001",

                iban:
                    "EG380001000000QA000000001",

                type:
                    "CURRENT",

                currency:
                    "EGP",

                balance:
                    25000000
            },
            {
                accountNumber:
                    "QA-SAVINGS-001",

                iban:
                    "EG380001000000QA000000002",

                type:
                    "SAVINGS",

                currency:
                    "EGP",

                balance:
                    10000000
            },
            {
                accountNumber:
                    "QA-USD-001",

                iban:
                    "EG380001000000QA000000003",

                type:
                    "CURRENT",

                currency:
                    "USD",

                balance:
                    500000
            }
        ];


        const accountIds = {};


        for (
            const account
            of accountSeeds
        ) {

            const result =
                await client.query(
                    `
                    INSERT INTO accounts (
                        user_id,
                        account_number,
                        iban,
                        account_type,
                        currency,
                        balance_minor,
                        daily_limit_minor,
                        status
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        5000000,
                        'ACTIVE'
                    )
                    ON CONFLICT (account_number)
                    DO UPDATE SET
                        user_id =
                            EXCLUDED.user_id,
                        iban =
                            EXCLUDED.iban,
                        account_type =
                            EXCLUDED.account_type,
                        currency =
                            EXCLUDED.currency,
                        balance_minor =
                            EXCLUDED.balance_minor,
                        status =
                            'ACTIVE'
                    RETURNING id
                    `,
                    [
                        customerId,
                        account.accountNumber,
                        account.iban,
                        account.type,
                        account.currency,
                        account.balance
                    ]
                );


            accountIds[
                account.accountNumber
            ] =
                result.rows[0].id;
        }


        const currentAccountId =
            accountIds[
                "QA-CURRENT-001"
            ];

        const savingsAccountId =
            accountIds[
                "QA-SAVINGS-001"
            ];


        // ====================================================
        // BENEFICIARIES
        // ====================================================

        await client.query(
            `
            DELETE FROM beneficiaries
            WHERE user_id = $1
              AND name LIKE 'QA Beneficiary%'
            `,
            [
                customerId
            ]
        );


        const beneficiaryResult =
            await client.query(
                `
                INSERT INTO beneficiaries (
                    user_id,
                    name,
                    nickname,
                    bank_name,
                    account_identifier,
                    currency,
                    verified,
                    status
                )
                VALUES (
                    $1,
                    'QA Beneficiary Primary',
                    'QA Primary',
                    'CAIRO TEST BANK',
                    'QA-BEN-001',
                    'EGP',
                    TRUE,
                    'ACTIVE'
                )
                RETURNING id
                `,
                [
                    customerId
                ]
            );


        const beneficiaryId =
            beneficiaryResult.rows[0].id;


        // ====================================================
        // CARDS
        // ====================================================

        await client.query(
            `
            DELETE FROM cards
            WHERE user_id = $1
            `,
            [
                customerId
            ]
        );


        await client.query(
            `
            INSERT INTO cards (
                user_id,
                account_id,
                last4,
                cardholder_name,
                expiry_month,
                expiry_year,
                status,
                atm_enabled,
                online_enabled,
                international_enabled,
                contactless_enabled,
                atm_limit_minor,
                purchase_limit_minor,
                online_limit_minor
            )
            VALUES (
                $1,
                $2,
                '4242',
                'QA CUSTOMER',
                12,
                2030,
                'ACTIVE',
                TRUE,
                TRUE,
                FALSE,
                TRUE,
                500000,
                1500000,
                1000000
            )
            `,
            [
                customerId,
                currentAccountId
            ]
        );


        // ====================================================
        // BILLERS
        // ====================================================

        const billerSeeds = [
            [
                "Cairo Electricity",
                "UTILITIES"
            ],
            [
                "Greater Cairo Water",
                "UTILITIES"
            ],
            [
                "Nova Telecom",
                "TELECOM"
            ],
            [
                "Egypt Internet",
                "INTERNET"
            ]
        ];


        const billerIds = {};


        for (
            const [name, category]
            of billerSeeds
        ) {

            const existing =
                await client.query(
                    `
                    SELECT id
                    FROM billers
                    WHERE name = $1
                    LIMIT 1
                    `,
                    [
                        name
                    ]
                );


            let billerId;


            if (
                existing.rowCount > 0
            ) {

                billerId =
                    existing.rows[0].id;


                await client.query(
                    `
                    UPDATE billers
                    SET
                        category = $2,
                        active = TRUE
                    WHERE id = $1
                    `,
                    [
                        billerId,
                        category
                    ]
                );

            } else {

                const inserted =
                    await client.query(
                        `
                        INSERT INTO billers (
                            name,
                            category,
                            active
                        )
                        VALUES (
                            $1,
                            $2,
                            TRUE
                        )
                        RETURNING id
                        `,
                        [
                            name,
                            category
                        ]
                    );


                billerId =
                    inserted.rows[0].id;
            }


            billerIds[name] =
                billerId;
        }


        // ====================================================
        // SAVED BILLER
        // ====================================================

        await client.query(
            `
            DELETE FROM saved_billers
            WHERE user_id = $1
            `,
            [
                customerId
            ]
        );


        await client.query(
            `
            INSERT INTO saved_billers (
                user_id,
                biller_id,
                alias,
                customer_reference
            )
            VALUES (
                $1,
                $2,
                'Home Electricity',
                'ELEC-QA-001'
            )
            `,
            [
                customerId,
                billerIds[
                    "Cairo Electricity"
                ]
            ]
        );


        // ====================================================
        // SAMPLE TRANSFER
        // ====================================================

        await client.query(
            `
            DELETE FROM transfers
            WHERE user_id = $1
              AND reference LIKE 'QA-SEED-%'
            `,
            [
                customerId
            ]
        );


        const transferResult =
            await client.query(
                `
                INSERT INTO transfers (
                    user_id,
                    from_account_id,
                    beneficiary_id,
                    reference,
                    transfer_type,
                    amount_minor,
                    fee_minor,
                    source_currency,
                    memo,
                    status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    'QA-SEED-TRANSFER-001',
                    'EXTERNAL',
                    250000,
                    500,
                    'EGP',
                    'Seed transfer',
                    'COMPLETED'
                )
                RETURNING id
                `,
                [
                    customerId,
                    currentAccountId,
                    beneficiaryId
                ]
            );


        const transferId =
            transferResult.rows[0].id;


        // ====================================================
        // BILL PAYMENT
        // ====================================================

        await client.query(
            `
            DELETE FROM bill_payments
            WHERE user_id = $1
              AND reference LIKE 'QA-SEED-%'
            `,
            [
                customerId
            ]
        );


        const paymentResult =
            await client.query(
                `
                INSERT INTO bill_payments (
                    user_id,
                    account_id,
                    biller_id,
                    reference,
                    customer_reference,
                    amount_minor,
                    status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    'QA-SEED-BILL-001',
                    'ELEC-QA-001',
                    120000,
                    'COMPLETED'
                )
                RETURNING id
                `,
                [
                    customerId,
                    currentAccountId,
                    billerIds[
                        "Cairo Electricity"
                    ]
                ]
            );


        const billPaymentId =
            paymentResult.rows[0].id;


        // ====================================================
        // LOAN
        // ====================================================

        await client.query(
            `
            DELETE FROM loans
            WHERE user_id = $1
            `,
            [
                customerId
            ]
        );


        const loanResult =
            await client.query(
                `
                INSERT INTO loans (
                    user_id,
                    disbursement_account_id,
                    loan_type,
                    amount_minor,
                    interest_rate,
                    term_months,
                    monthly_payment_minor,
                    remaining_principal_minor,
                    purpose,
                    status,
                    underwriter_note,
                    reviewed_by,
                    reviewed_at
                )
                VALUES (
                    $1,
                    $2,
                    'PERSONAL',
                    5000000,
                    14.5000,
                    24,
                    241200,
                    4200000,
                    'QA seed personal loan',
                    'ACTIVE',
                    'Approved QA seed loan.',
                    $3,
                    NOW()
                )
                RETURNING id
                `,
                [
                    customerId,
                    currentAccountId,
                    adminId
                ]
            );


        const loanId =
            loanResult.rows[0].id;


        // ====================================================
        // TRANSACTION HISTORY
        // ====================================================

        await client.query(
            `
            DELETE FROM transactions
            WHERE user_id = $1
              AND reference LIKE 'QA-SEED-%'
            `,
            [
                customerId
            ]
        );


        const transactions = [
            {
                accountId:
                    currentAccountId,

                transferId:
                    null,

                billPaymentId:
                    null,

                loanId:
                    null,

                reference:
                    "QA-SEED-DEPOSIT-001",

                type:
                    "DEPOSIT",

                description:
                    "QA salary deposit",

                direction:
                    "CREDIT",

                amount:
                    1500000,

                fee:
                    0,

                balance:
                    25000000,

                currency:
                    "EGP"
            },
            {
                accountId:
                    currentAccountId,

                transferId,

                billPaymentId:
                    null,

                loanId:
                    null,

                reference:
                    "QA-SEED-TRANSFER-001",

                type:
                    "TRANSFER",

                description:
                    "Transfer to QA Beneficiary Primary",

                direction:
                    "DEBIT",

                amount:
                    250000,

                fee:
                    500,

                balance:
                    24749500,

                currency:
                    "EGP"
            },
            {
                accountId:
                    currentAccountId,

                transferId:
                    null,

                billPaymentId,

                loanId:
                    null,

                reference:
                    "QA-SEED-BILL-001",

                type:
                    "BILL_PAYMENT",

                description:
                    "Cairo Electricity payment",

                direction:
                    "DEBIT",

                amount:
                    120000,

                fee:
                    0,

                balance:
                    24629500,

                currency:
                    "EGP"
            },
            {
                accountId:
                    currentAccountId,

                transferId:
                    null,

                billPaymentId:
                    null,

                loanId,

                reference:
                    "QA-SEED-LOAN-001",

                type:
                    "LOAN_DISBURSEMENT",

                description:
                    "Personal loan disbursement",

                direction:
                    "CREDIT",

                amount:
                    5000000,

                fee:
                    0,

                balance:
                    29629500,

                currency:
                    "EGP"
            }
        ];


        for (
            const transaction
            of transactions
        ) {

            await client.query(
                `
                INSERT INTO transactions (
                    user_id,
                    account_id,
                    transfer_id,
                    bill_payment_id,
                    loan_id,
                    reference,
                    transaction_type,
                    description,
                    direction,
                    amount_minor,
                    fee_minor,
                    balance_after_minor,
                    currency,
                    status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    $12,
                    $13,
                    'COMPLETED'
                )
                `,
                [
                    customerId,
                    transaction.accountId,
                    transaction.transferId,
                    transaction.billPaymentId,
                    transaction.loanId,
                    transaction.reference,
                    transaction.type,
                    transaction.description,
                    transaction.direction,
                    transaction.amount,
                    transaction.fee,
                    transaction.balance,
                    transaction.currency
                ]
            );
        }


        // ====================================================
        // SAVINGS TRANSACTION
        // ====================================================

        await client.query(
            `
            INSERT INTO transactions (
                user_id,
                account_id,
                reference,
                transaction_type,
                description,
                direction,
                amount_minor,
                fee_minor,
                balance_after_minor,
                currency,
                status
            )
            VALUES (
                $1,
                $2,
                'QA-SEED-SAVINGS-001',
                'DEPOSIT',
                'Initial QA savings balance',
                'CREDIT',
                10000000,
                0,
                10000000,
                'EGP',
                'COMPLETED'
            )
            `,
            [
                customerId,
                savingsAccountId
            ]
        );


        // ====================================================
        // NOTIFICATIONS
        // ====================================================

        await client.query(
            `
            DELETE FROM notifications
            WHERE user_id = $1
            `,
            [
                customerId
            ]
        );


        const notifications = [
            [
                "Welcome to NovaBank",
                "Your QA banking profile is ready."
            ],
            [
                "Transfer completed",
                "QA-SEED-TRANSFER-001 was completed successfully."
            ],
            [
                "Statement available",
                "Your latest account statement is available."
            ]
        ];


        for (
            const notification
            of notifications
        ) {

            await client.query(
                `
                INSERT INTO notifications (
                    user_id,
                    title,
                    message,
                    channel
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    'IN_APP'
                )
                `,
                [
                    customerId,
                    notification[0],
                    notification[1]
                ]
            );
        }


        // ====================================================
        // AUDIT LOG
        // ====================================================

        await client.query(
            `
            INSERT INTO audit_logs (
                actor_user_id,
                action,
                entity_type,
                entity_id,
                result,
                metadata_json
            )
            VALUES (
                $1,
                'QA_DATABASE_SEED',
                'SYSTEM',
                'NOVABANK-QA-SEED',
                'SUCCESS',
                $2::jsonb
            )
            `,
            [
                adminId,
                JSON.stringify({
                    source:
                        "scripts/seed.js",

                    seededAt:
                        new Date()
                            .toISOString()
                })
            ]
        );


        await client.query(
            "COMMIT"
        );


        // ====================================================
        // SUMMARY
        // ====================================================

        console.log(
            "NovaBank QA seed completed successfully."
        );

        console.log("");

        console.log(
            "Customer:"
        );

        console.log(
            "  customer@novabank.test"
        );

        console.log("");

        console.log(
            "Staff:"
        );

        console.log(
            "  admin@novabank.test"
        );

        console.log(
            "  manager@novabank.test"
        );

        console.log(
            "  employee@novabank.test"
        );

        console.log(
            "  support@novabank.test"
        );

        console.log(
            "  auditor@novabank.test"
        );

        console.log("");

        console.log(
            "MFA code:"
        );

        console.log(
            "  123456"
        );

        console.log("");

        console.log(
            "Passwords were loaded from environment variables."
        );


    } catch (error) {

        await client.query(
            "ROLLBACK"
        );

        throw error;

    } finally {

        client.release();

        await pool.end();
    }
}


seed()
    .catch(
        error => {

            console.error("");
            console.error(
                "NovaBank QA seed failed:"
            );

            console.error(
                error
            );

            process.exit(1);
        }
    );
