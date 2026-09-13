require("dotenv").config();

function getEnv(name, defaultValue = undefined) {
    const value = process.env[name];

    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return defaultValue;
    }

    return value;
}

function requireEnv(name) {
    const value = getEnv(name);

    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}`
        );
    }

    return value;
}

module.exports = {
    getEnv,
    requireEnv
};
