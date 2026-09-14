const jwt =
    require("jsonwebtoken");

const {
    requireEnv,
    getEnv
} = require("../utils/env");


function createMfaChallenge(user) {

    return jwt.sign(
        {
            type: "MFA_CHALLENGE",

            sub:
                String(user.id),

            email:
                user.email,

            role:
                user.role
        },

        requireEnv(
            "JWT_MFA_SECRET"
        ),

        {
            expiresIn:
                getEnv(
                    "JWT_MFA_EXPIRY",
                    "5m"
                ),

            issuer:
                "novabank",

            audience:
                "novabank-mfa"
        }
    );
}


function verifyMfaChallenge(token) {

    const payload =
        jwt.verify(
            token,

            requireEnv(
                "JWT_MFA_SECRET"
            ),

            {
                issuer:
                    "novabank",

                audience:
                    "novabank-mfa"
            }
        );


    if (
        payload.type !==
        "MFA_CHALLENGE"
    ) {

        throw new Error(
            "Invalid MFA challenge token."
        );
    }


    return payload;
}


function createAccessToken(user) {

    return jwt.sign(
        {
            type:
                "ACCESS",

            sub:
                String(user.id),

            email:
                user.email,

            role:
                user.role
        },

        requireEnv(
            "JWT_ACCESS_SECRET"
        ),

        {
            expiresIn:
                getEnv(
                    "JWT_ACCESS_EXPIRY",
                    "8h"
                ),

            issuer:
                "novabank",

            audience:
                "novabank-api"
        }
    );
}


function verifyAccessToken(token) {

    const payload =
        jwt.verify(
            token,

            requireEnv(
                "JWT_ACCESS_SECRET"
            ),

            {
                issuer:
                    "novabank",

                audience:
                    "novabank-api"
            }
        );


    if (
        payload.type !==
        "ACCESS"
    ) {

        throw new Error(
            "Invalid access token."
        );
    }


    return payload;
}


module.exports = {
    createMfaChallenge,
    verifyMfaChallenge,
    createAccessToken,
    verifyAccessToken
};
