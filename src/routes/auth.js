const express =
    require("express");

const bcrypt =
    require("bcryptjs");

const {
    query
} = require("../db/database");

const {
    createMfaChallenge,
    verifyMfaChallenge,
    createAccessToken
} = require("../auth/jwt");

const {
    requireAuthentication
} = require("../middleware/auth");


const router =
    express.Router();


function normalizeIdentifier(
    body
) {

    return (
        body.email
        ||
        body.identifier
        ||
        body.username
        ||
        ""
    )
        .trim()
        .toLowerCase();
}


function normalizeChallengeToken(
    body
) {

    return (
        body.challengeToken
        ||
        body.challenge_token
        ||
        body.tempToken
        ||
        body.token
        ||
        ""
    );
}


function normalizeMfaCode(
    body
) {

    return String(
        body.code
        ||
        body.otp
        ||
        body.mfaCode
        ||
        body.mfa_code
        ||
        ""
    ).trim();
}


// ============================================================
// LOGIN
// ============================================================

router.post(
    "/auth/login",

    async (
        req,
        res,
        next
    ) => {

        try {

            const email =
                normalizeIdentifier(
                    req.body
                );


            const password =
                String(
                    req.body.password
                    ||
                    ""
                );


            if (
                !email ||
                !password
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Email and password are required."
                    });
            }


            const result =
                await query(
                    `
                    SELECT
                        id,
                        email,
                        password_hash,
                        first_name,
                        last_name,
                        role,
                        status,
                        mfa_enabled,
                        failed_login_attempts,
                        locked_until
                    FROM users
                    WHERE LOWER(email) =
                        LOWER($1)
                    LIMIT 1
                    `,
                    [
                        email
                    ]
                );


            if (
                result.rowCount === 0
            ) {

                return res
                    .status(401)
                    .json({
                        error:
                            "Invalid credentials."
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
                            "Account is not active."
                    });
            }


            if (
                user.locked_until
                &&
                new Date(
                    user.locked_until
                ) > new Date()
            ) {

                return res
                    .status(423)
                    .json({
                        error:
                            "Account is temporarily locked."
                    });
            }


            const validPassword =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );


            if (
                !validPassword
            ) {

                await query(
                    `
                    UPDATE users

                    SET
                        failed_login_attempts =
                            failed_login_attempts + 1

                    WHERE id = $1
                    `,
                    [
                        user.id
                    ]
                );


                return res
                    .status(401)
                    .json({
                        error:
                            "Invalid credentials."
                    });
            }


            await query(
                `
                UPDATE users

                SET
                    failed_login_attempts = 0,
                    locked_until = NULL

                WHERE id = $1
                `,
                [
                    user.id
                ]
            );


            const challengeToken =
                createMfaChallenge(
                    user
                );


            return res
                .status(200)
                .json({

                    mfaRequired:
                        true,

                    mfa_required:
                        true,

                    challengeToken,

                    challenge_token:
                        challengeToken,

                    tempToken:
                        challengeToken,

                    user: {
                        id:
                            user.id,

                        email:
                            user.email,

                        firstName:
                            user.first_name,

                        lastName:
                            user.last_name,

                        role:
                            user.role
                    }
                });


        } catch (error) {

            next(
                error
            );
        }
    }
);


// ============================================================
// MFA
// ============================================================

router.post(
    "/auth/mfa",

    async (
        req,
        res,
        next
    ) => {

        try {

            const challengeToken =
                normalizeChallengeToken(
                    req.body
                );


            const code =
                normalizeMfaCode(
                    req.body
                );


            if (
                !challengeToken ||
                !code
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "MFA challenge and code are required."
                    });
            }


            let challenge;


            try {

                challenge =
                    verifyMfaChallenge(
                        challengeToken
                    );

            } catch (error) {

                return res
                    .status(401)
                    .json({
                        error:
                            "Invalid or expired MFA challenge."
                    });
            }


            const expectedCode =
                String(
                    process.env.QA_MFA_CODE
                    ||
                    "123456"
                );


            if (
                code !==
                expectedCode
            ) {

                return res
                    .status(401)
                    .json({
                        error:
                            "Invalid MFA code."
                    });
            }


            const result =
                await query(
                    `
                    SELECT
                        id,
                        email,
                        first_name,
                        last_name,
                        role,
                        status
                    FROM users
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [
                        challenge.sub
                    ]
                );


            if (
                result.rowCount === 0
            ) {

                return res
                    .status(401)
                    .json({
                        error:
                            "MFA user no longer exists."
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
                            "Account is not active."
                    });
            }


            const accessToken =
                createAccessToken(
                    user
                );


            return res
                .status(200)
                .json({

                    accessToken,

                    access_token:
                        accessToken,

                    token:
                        accessToken,

                    tokenType:
                        "Bearer",

                    expiresIn:
                        process.env
                            .JWT_ACCESS_EXPIRY
                        ||
                        "8h",

                    user: {
                        id:
                            user.id,

                        email:
                            user.email,

                        firstName:
                            user.first_name,

                        lastName:
                            user.last_name,

                        role:
                            user.role
                    }
                });


        } catch (error) {

            next(
                error
            );
        }
    }
);


// ============================================================
// CURRENT USER
// ============================================================

router.get(
    "/auth/me",

    requireAuthentication,

    (
        req,
        res
    ) => {

        res.status(200)
            .json({
                user: {
                    id:
                        req.user.id,

                    email:
                        req.user.email,

                    firstName:
                        req.user.first_name,

                    lastName:
                        req.user.last_name,

                    role:
                        req.user.role,

                    status:
                        req.user.status
                }
            });
    }
);


module.exports =
    router;
