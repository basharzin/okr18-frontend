// ---------------------------------------------------------------
// Cloudflare Turnstile (our external API): proves a human is signing up
// or logging in. The browser widget gives a one-time token; we send it,
// with our SECRET key, to Cloudflare's siteverify API.
// The secret is read from Secrets Manager (okr18/turnstile-secret) once per
// Lambda container. It never appears in code, logs, the repo or the browser.
// If Cloudflare cannot be reached we refuse (fail closed), never skip the check.
// ---------------------------------------------------------------
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

class BotCheckUnavailable extends Error {}

function createTurnstile({ secretId = process.env.TURNSTILE_SECRET_ARN, client, fetchFn = fetch } = {}) {
    if (!secretId) throw new Error('TURNSTILE_SECRET_ARN is not set.');
    const sm = client || new SecretsManagerClient({});
    let secret;   // cached for the life of the container

    async function getSecret() {
        if (!secret) {
            const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
            secret = out.SecretString;
        }
        return secret;
    }

    // true = human, false = refused by Cloudflare
    async function verify(token, remoteIp) {
        if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return false;
        const form = new URLSearchParams({ secret: await getSecret(), response: token });
        if (remoteIp) form.set('remoteip', remoteIp);
        let res;
        try {
            res = await fetchFn(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(4000) });
        } catch (error) {
            throw new BotCheckUnavailable('Turnstile could not be reached.');
        }
        if (!res.ok) throw new BotCheckUnavailable(`Turnstile answered ${res.status}.`);
        const body = await res.json();
        return body.success === true;
    }

    return { verify };
}

module.exports = { createTurnstile, BotCheckUnavailable };
