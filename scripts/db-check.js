require("dotenv").config();

const {
    getPool
} = require("../src/db/database");


async function check() {

    const pool =
        getPool();

    if (!pool) {

        throw new Error(
            "DATABASE_URL is not configured."
        );
    }


    const result =
        await pool.query(`
            SELECT
                table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);


    console.log(
        "NovaBank PostgreSQL tables:"
    );


    for (
        const row
        of result.rows
    ) {

        console.log(
            ` - ${row.table_name}`
        );
    }


    console.log(
        ""
    );

    console.log(
        `Total tables: ${result.rows.length}`
    );


    await pool.end();
}


check()
    .catch(
        error => {

            console.error(
                error
            );

            process.exit(1);
        }
    );
