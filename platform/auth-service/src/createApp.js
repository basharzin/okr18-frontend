// ---------------------------------------------------------------
// Sign-up, login, logout and "who am I" for the whole app.
// Every sign-up and login passes Turnstile first (T1, T2 in the threat model).
// Failed logins are logged with a short hash of the email, never the email
// or the password, so repeated failures on one account show up in CloudWatch.
// ---------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { requireUser } = require('./tokens');
const { BotCheckUnavailable } = require('./turnstile');
const { securityHeaders, rateLimit } = require('./protect');

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function sendError(res, status, code, message) {
    return res.status(status).json({ error: { code, message } });
}
const emailTag = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
const security = (event, fields) => console.log(JSON.stringify({ service: 'auth', security: event, ...fields }));

function checkCredentials(body, { signUp }) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!EMAIL.test(email)) return { error: 'Enter a valid email address.' };
    if (signUp) {
        const strong = password.length >= 10 && password.length <= 128 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
        if (!strong) return { error: 'Password needs 10 or more characters with upper case, lower case and a number.' };
    } else if (!password || password.length > 128) {
        return { error: 'Enter your password.' };
    }
    return { email, password };
}

function createApp({ cognito, turnstile, verify, attempts, allowedOrigins = [], rateLimitMax }) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => console.log(JSON.stringify({ service: 'auth', method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - start })));
        next();
    });
    app.use(securityHeaders);                                        // on every answer, errors too
    app.use(cors({ origin: allowedOrigins }));                       // answers the browser's OPTIONS preflight itself
    app.use(rateLimit({ max: rateLimitMax, service: 'auth' }));      // 429 after the limit (per IP, 60 s)
    app.use((req, res, next) => (req.method === 'POST' && req.path !== '/api/auth/logout' && !req.is('application/json')
        ? sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.') : next()));
    app.use(express.json({ limit: '4kb' }));

    // Turnstile first: a bot never reaches Cognito
    const botCheck = async (req, res, next) => {
        const ip = req.requestContext?.http?.sourceIp || req.ip;
        const human = await turnstile.verify(req.body?.turnstileToken, ip);
        if (!human) {
            security('bot_check_failed', { path: req.path });
            return sendError(res, 403, 'BOT_CHECK_FAILED', 'The bot check failed. Reload the page and try again.');
        }
        return next();
    };

    app.post('/api/auth/signup', botCheck, async (req, res) => {
        const c = checkCredentials(req.body, { signUp: true });
        if (c.error) return sendError(res, 400, 'VALIDATION_ERROR', c.error);
        try {
            await cognito.signUp(c.email, c.password);
            security('signed_up', { user: emailTag(c.email) });
            return res.status(201).json({ email: c.email, message: 'Account created. You can log in now.' });
        } catch (error) {
            if (error.name === 'UsernameExistsException') return sendError(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.');
            if (error.name === 'InvalidPasswordException') return sendError(res, 400, 'VALIDATION_ERROR', 'Choose a stronger password.');
            throw error;
        }
    });

    app.post('/api/auth/login', botCheck, async (req, res) => {
        const c = checkCredentials(req.body, { signUp: false });
        if (c.error) return sendError(res, 400, 'VALIDATION_ERROR', c.error);
        const tag = emailTag(c.email);

        // Locked accounts are refused before Cognito is even asked (T1, ST8)
        const left = await attempts.lockedFor(tag);
        if (left) {
            security('login_locked', { user: tag });
            res.set('Retry-After', String(Math.ceil(left / 1000)));
            return sendError(res, 429, 'TOO_MANY_ATTEMPTS', `Too many wrong passwords. Try again in ${Math.ceil(left / 60000)} minutes.`);
        }
        try {
            const tokens = await cognito.logIn(c.email, c.password);
            await attempts.clear(tag);
            security('logged_in', { user: tag });
            return res.status(200).json({ accessToken: tokens.AccessToken, expiresIn: tokens.ExpiresIn });
        } catch (error) {
            if (['NotAuthorizedException', 'UserNotFoundException'].includes(error.name)) {
                // Same answer for a wrong password and an unknown email: no account guessing
                const state = await attempts.recordFailure(tag);
                security('login_failed', { user: tag, reason: error.name, failures: state.failures, locked: state.lockedUntil > 0 });
                return sendError(res, 401, 'INVALID_CREDENTIALS', 'Email or password is wrong.');
            }
            if (error.name === 'TooManyRequestsException' || error.name === 'LimitExceededException') {
                security('login_throttled', { user: emailTag(c.email) });
                return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a few minutes.');
            }
            throw error;
        }
    });

    app.post('/api/auth/logout', requireUser(verify), async (req, res) => {
        const token = (req.get('authorization') || '').replace(/^Bearer /, '');
        await cognito.logOut(token);   // revokes this user's refresh tokens
        return res.status(204).end();
    });

    app.get('/api/auth/me', requireUser(verify), (req, res) => res.status(200).json({ userId: req.user.id, groups: req.user.groups }));

    app.use((req, res) => sendError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found.'));
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error.type === 'entity.parse.failed') return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
        if (error.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
        if (error instanceof BotCheckUnavailable) {
            security('bot_check_unavailable', { detail: error.message });
            return sendError(res, 503, 'BOT_CHECK_UNAVAILABLE', 'The bot check is not answering. Try again shortly.');
        }
        console.error(JSON.stringify({ service: 'auth', error: error.name }));   // no message: it can contain the email
        return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
    });
    return app;
}

module.exports = { createApp };
