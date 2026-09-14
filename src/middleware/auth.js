const {
    verifyAccessToken
} = require("../auth/jwt");

const {
    query
} = require("../db/database");


async function requireAuthentication(
    req,
    res,
    next
) {

    try {

        const header =
            req.headers.authorization;


        if (
            !header ||
            !header.startsWith(
                "Bearer "
            )
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Authentication required."
                });
        }


        const token =
            header.substring(
                "Bearer ".length
            );


        const payload =
            verifyAccessToken(
                token
            );


        const result =
            await query(
                `
                SELECT
                    id,
                    email,
                    first_name,
                    last_name,
                    role,
                    status,
                    email_verified,
                    mfa_enabled
                FROM users
                WHERE id = $1
                LIMIT 1
                `,
                [
                    payload.sub
                ]
            );


        if (
            result.rowCount === 0
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Authenticated user no longer exists."
                });
        }


        const user =
            result.rows[0];


        if (
            user.status !==
            "ACTIVE"
        ) {

            return res
                .status(403)
                .json({
                    error:
                        "User account is not active."
                });
        }


        req.auth = {
            userId:
                user.id,

            email:
                user.email,

            role:
                user.role
        };


        req.user =
            user;


        next();

    } catch (error) {

        if (
            error.name ===
                "JsonWebTokenError"
            ||
            error.name ===
                "TokenExpiredError"
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Invalid or expired access token."
                });
        }


        next(
            error
        );
    }
}


function requireRole(
    ...roles
) {

    return function (
        req,
        res,
        next
    ) {

        if (
            !req.auth
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Authentication required."
                });
        }


        if (
            !roles.includes(
                req.auth.role
            )
        ) {

            return res
                .status(403)
                .json({
                    error:
                        "Insufficient permissions."
                });
        }


        next();
    };
}


module.exports = {
    requireAuthentication,
    requireRole
};
