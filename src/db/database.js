const { Pool } = require("pg");
const { getEnv } = require("../utils/env");

let pool = null;

function getPool() {

    if (pool) {
        return pool;
    }

    const connectionString =
        getEnv("DATABASE_URL");

    if (!connectionString) {
        return null;
    }

    pool = new Pool({
        connectionString,
        ssl: getEnv("DATABASE_SSL", "true") === "true"
            ? {
                rejectUnauthorized: false
            }
            : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });

    pool.on("error", error => {

        console.error(
            "Unexpected PostgreSQL pool error:",
            error
        );
    });

    return pool;
}


async function query(
    text,
    params = []
) {

    const activePool =
        getPool();

    if (!activePool) {
        throw new Error(
            "DATABASE_URL is not configured."
        );
    }

    return activePool.query(
        text,
        params
    );
}


async function checkDatabaseConnection() {

    const activePool =
        getPool();

    if (!activePool) {

        return {
            configured: false,
            connected: false
        };
    }

    try {

        const result =
            await activePool.query(
                "SELECT NOW() AS current_time"
            );

        return {
            configured: true,
            connected: true,
            currentTime:
                result.rows[0].current_time
        };

    } catch (error) {

        return {
            configured: true,
            connected: false,
            error: error.message
        };
    }
}


module.exports = {
    getPool,
    query,
    checkDatabaseConnection
};
