const express = require("express");
const helmet = require("helmet");
const path = require("path");

const healthRoutes =
    require("./routes/health");

const app =
    express();


app.disable(
    "x-powered-by"
);


app.use(
    helmet({
        contentSecurityPolicy: false
    })
);


app.use(
    express.json({
        limit: "5mb"
    })
);


app.use(
    express.urlencoded({
        extended: true
    })
);


// ------------------------------------------------------------
// API ROUTES
// ------------------------------------------------------------

app.use(
    "/api",
    healthRoutes
);


// ------------------------------------------------------------
// STATIC FRONTEND
//
// Used when running NovaBank locally.
// Vercel serves /public directly in production.
// ------------------------------------------------------------

const publicDirectory =
    path.join(
        __dirname,
        "..",
        "public"
    );

app.use(
    express.static(
        publicDirectory
    )
);


app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                publicDirectory,
                "index.html"
            )
        );
    }
);


// ------------------------------------------------------------
// API 404
// ------------------------------------------------------------

app.use(
    "/api",
    (req, res) => {

        res.status(404).json({
            error: "API endpoint not found."
        });
    }
);


// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled API error:",
            error
        );

        res.status(500).json({
            error:
                "Internal server error."
        });
    }
);


module.exports =
    app;
