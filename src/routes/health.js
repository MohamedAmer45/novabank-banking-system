const express = require("express");

const {
    checkDatabaseConnection
} = require("../db/database");

const router =
    express.Router();


router.get(
    "/health",
    async (req, res) => {

        const database =
            await checkDatabaseConnection();

        const healthy =
            !database.configured
            || database.connected;

        res.status(
            healthy ? 200 : 503
        ).json({
            service: "NovaBank API",
            status:
                healthy
                    ? "UP"
                    : "DEGRADED",
            timestamp:
                new Date().toISOString(),
            database
        });
    }
);


module.exports =
    router;
