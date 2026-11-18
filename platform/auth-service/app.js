// The real auth app wired to Cognito, Turnstile and Secrets Manager (no listen).
require('dotenv').config({ quiet: true });
const { createApp } = require('./src/createApp');
const { createCognito } = require('./src/cognito');
const { createTurnstile } = require('./src/turnstile');
const { createVerifier } = require('./src/tokens');
const { createLoginAttempts } = require('./src/loginAttempts');

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((o) => o.trim()).filter(Boolean);

module.exports = createApp({
    cognito: createCognito(),
    turnstile: createTurnstile(),
    verify: createVerifier(),
    attempts: createLoginAttempts(),
    allowedOrigins
});
