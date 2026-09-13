const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const {
    getPool
} = require("../src/db/database");


async function migrate() {

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

        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id BIGSERIAL PRIMARY KEY,
                file_name VARCHAR(255) NOT NULL UNIQUE,
                executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);


        const migrationsDirectory =
            path.join(
                __dirname,
                "..",
                "migrations"
            );


        const migrationFiles =
            fs.readdirSync(
                migrationsDirectory
            )
            .filter(
                file =>
                    file.endsWith(".sql")
            )
            .sort();


        for (
            const fileName
            of migrationFiles
        ) {

            const existing =
                await client.query(
                    `
                    SELECT 1
                    FROM schema_migrations
                    WHERE file_name = $1
                    `,
                    [
                        fileName
                    ]
                );


            if (
                existing.rowCount > 0
            ) {

                console.log(
                    `SKIP ${fileName}`
                );

                continue;
            }


            const fullPath =
                path.join(
                    migrationsDirectory,
                    fileName
                );


            const sql =
                fs.readFileSync(
                    fullPath,
                    "utf8"
                );


            console.log(
                `RUN  ${fileName}`
            );


            await client.query(
                "BEGIN"
            );


            try {

                await client.query(
                    sql
                );


                await client.query(
                    `
                    INSERT INTO schema_migrations (
                        file_name
                    )
                    VALUES ($1)
                    `,
                    [
                        fileName
                    ]
                );


                await client.query(
                    "COMMIT"
                );


                console.log(
                    `DONE ${fileName}`
                );

            } catch (error) {

                await client.query(
                    "ROLLBACK"
                );

                throw error;
            }
        }


        console.log(
            ""
        );

        console.log(
            "Database migrations completed successfully."
        );

    } finally {

        client.release();

        await pool.end();
    }
}


migrate()
    .catch(
        error => {

            console.error(
                "Migration failed:"
            );

            console.error(
                error
            );

            process.exit(1);
        }
    );
