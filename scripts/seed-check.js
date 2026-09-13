require("dotenv").config();

const {
    getPool
} = require("../src/db/database");


async function verify() {

    const pool =
        getPool();

    if (!pool) {
        throw new Error(
            "DATABASE_URL is not configured."
        );
    }


    const checks = [
        [
            "Users",
            "SELECT COUNT(*)::int AS count FROM users"
        ],
        [
            "Accounts",
            "SELECT COUNT(*)::int AS count FROM accounts"
        ],
        [
            "Beneficiaries",
            "SELECT COUNT(*)::int AS count FROM beneficiaries"
        ],
        [
            "Cards",
            "SELECT COUNT(*)::int AS count FROM cards"
        ],
        [
            "Billers",
            "SELECT COUNT(*)::int AS count FROM billers"
        ],
        [
            "Saved billers",
            "SELECT COUNT(*)::int AS count FROM saved_billers"
        ],
        [
            "Bill payments",
            "SELECT COUNT(*)::int AS count FROM bill_payments"
        ],
        [
            "Transfers",
            "SELECT COUNT(*)::int AS count FROM transfers"
        ],
        [
            "Transactions",
            "SELECT COUNT(*)::int AS count FROM transactions"
        ],
        [
            "Loans",
            "SELECT COUNT(*)::int AS count FROM loans"
        ],
        [
            "Notifications",
            "SELECT COUNT(*)::int AS count FROM notifications"
        ],
        [
            "KYC profiles",
            "SELECT COUNT(*)::int AS count FROM kyc_profiles"
        ]
    ];


    console.log("");
    console.log("NovaBank QA database:");
    console.log("");


    for (
        const [name, sql]
        of checks
    ) {

        const result =
            await pool.query(
                sql
            );


        console.log(
            `${name}: ${result.rows[0].count}`
        );
    }


    const customer =
        await pool.query(
            `
            SELECT
                u.email,
                u.role,
                u.status,
                k.status AS kyc_status
            FROM users u

            LEFT JOIN kyc_profiles k
                ON k.user_id = u.id

            WHERE LOWER(u.email) =
                LOWER('customer@novabank.test')
            `
        );


    console.log("");
    console.log(
        "QA customer:"
    );

    console.table(
        customer.rows
    );


    const accounts =
        await pool.query(
            `
            SELECT
                account_number,
                account_type,
                currency,
                balance_minor,
                status
            FROM accounts
            WHERE user_id = (
                SELECT id
                FROM users
                WHERE LOWER(email) =
                    LOWER('customer@novabank.test')
            )
            ORDER BY id
            `
        );


    console.log("");
    console.log(
        "QA customer accounts:"
    );

    console.table(
        accounts.rows
    );


    await pool.end();
}


verify()
    .catch(
        error => {

            console.error(
                error
            );

            process.exit(1);
        }
    );
