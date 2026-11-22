// ---------------------------------------------------------------
// Security tests ST1, ST2, ST3, ST5 and ST8 (design doc, section "Security tests"),
// run against the real app on Floci. Prints Expected / Actual / PASS or FAIL
// for each check, so one screenshot is the evidence for the report.
//
// Run from okr18-frontend/infra/tools in Git Bash, after bash infra/deploy-all.sh:
//   npm install
//   node security-tests.js
//
// It makes its own throw-away users (st-*@okr18.test) and data, and deletes them at the end.
// It never prints a token, a password or the Turnstile secret.
// ---------------------------------------------------------------
if (!process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) process.env.AWS_PROFILE = 'floci';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CognitoIdentityProviderClient, ...cog } = require('@aws-sdk/client-cognito-identity-provider');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// ---------- settings from the shared setup (ids only) ----------
const VARS_FILE = path.join(__dirname, '..', 'okr18-vars.sh');
if (!fs.existsSync(VARS_FILE)) {
    console.error('infra/okr18-vars.sh not found. Run bash infra/deploy-all.sh first.');
    process.exit(1);
}
const vars = {};
for (const line of fs.readFileSync(VARS_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^export ([A-Z_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2].replace(/^"|"$/g, '');
}
const API = vars.API_URL;
const POOL = vars.COGNITO_USER_POOL_ID;
const CLIENT = vars.COGNITO_CLIENT_ID;
const cfg = { region: vars.AWS_REGION || 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:4566' };
const cognito = new CognitoIdentityProviderClient(cfg);

// Cloudflare's public test values (https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
const TEST_SECRET_ALWAYS_PASSES = '1x0000000000000000000000000000000AA';
const DUMMY_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const RUN = Date.now().toString(36);
const PASSWORD = `St-${crypto.randomBytes(6).toString('hex')}-Aa1`;
const results = [];
const cleanup = [];

// ---------- helpers ----------
function record(id, test, expected, actual, ok, info = false) {
    const status = info ? 'INFO' : ok ? 'PASS' : 'FAIL';
    results.push({ id, status });
    console.log(`${status.padEnd(5)} ${id.padEnd(5)} ${test}`);
    console.log(`            expected: ${expected}`);
    console.log(`            actual:   ${actual}`);
}

async function call(method, route, { token, body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(`${API}${route}`, { method, headers: h, body: payload });
    let json = null;
    try { json = await res.json(); } catch { /* empty or not JSON */ }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}

async function makeUser(label) {
    const email = `st-${label}-${RUN}@okr18.test`;
    await cognito.send(new cog.AdminCreateUserCommand({ UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS' }));
    cleanup.push(() => cognito.send(new cog.AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })));
    await cognito.send(new cog.AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: PASSWORD, Permanent: true }));
    await cognito.send(new cog.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'user' }));
    return email;
}

async function tokensFor(email) {
    const out = await cognito.send(new cog.InitiateAuthCommand({
        ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD }
    }));
    return { access: out.AuthenticationResult.AccessToken, id: out.AuthenticationResult.IdToken };
}

async function userExists(email) {
    try { await cognito.send(new cog.AdminGetUserCommand({ UserPoolId: POOL, Username: email })); return true; }
    catch (e) { if (e.name === 'UserNotFoundException') return false; throw e; }
}

// Same token, but the payload says it belongs to someone else: the signature no longer matches
function tamper(jwt) {
    const [h, p, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    claims.sub = crypto.randomUUID();
    return `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
}

// A token signed with our own key instead of Cognito's
function forge(jwt) {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'attacker-key' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
}

// ---------- tests ----------
async function st1(a) {
    console.log('\n== ST1  Calls without a valid login are refused');
    let r = await call('GET', '/api/goals');
    record('ST1', 'GET /api/goals with no token', '401', r.status, r.status === 401);

    r = await call('GET', '/api/goals', { token: 'not-a-token' });
    record('ST1b', 'GET /api/goals with a random string as token', '401', r.status, r.status === 401);

    r = await call('GET', '/api/goals', { token: tamper(a.access) });
    record('ST1c', 'Real token with the user id changed (signature broken)', '401', r.status, r.status === 401);

    r = await call('GET', '/api/goals', { token: forge(a.access) });
    record('ST1d', 'Token signed with an attacker key', '401', r.status, r.status === 401);

    r = await call('GET', '/api/goals', { token: a.id });
    record('ST1e', 'ID token instead of access token', '401', r.status, r.status === 401);

    r = await call('GET', '/api/goals', { token: a.access });
    record('ST1f', 'Control: the same user with the real access token', '200', r.status, r.status === 200);
}

async function st2(testSecret) {
    console.log('\n== ST2  Sign-up must pass the Turnstile bot check first');
    const missing = `st-nobot-${RUN}@okr18.test`;
    let r = await call('POST', '/api/auth/signup', { body: { email: missing, password: PASSWORD } });
    let exists = await userExists(missing);
    if (exists) cleanup.push(() => cognito.send(new cog.AdminDeleteUserCommand({ UserPoolId: POOL, Username: missing })));
    record('ST2', 'Sign up with NO Turnstile token', '403 BOT_CHECK_FAILED, no account in Cognito',
        `${r.status} ${r.json?.error?.code || ''}, account created: ${exists ? 'yes' : 'no'}`, r.status === 403 && !exists);

    const fake = `st-fakebot-${RUN}@okr18.test`;
    r = await call('POST', '/api/auth/signup', { body: { email: fake, password: PASSWORD, turnstileToken: 'fake-token-made-up-by-a-bot' } });
    exists = await userExists(fake);
    if (exists) cleanup.push(() => cognito.send(new cog.AdminDeleteUserCommand({ UserPoolId: POOL, Username: fake })));
    if (testSecret) {
        record('ST2b', 'Sign up with a FAKE Turnstile token',
            '403 with the real secret. This Floci uses Cloudflare\'s test secret, which accepts any token',
            `${r.status} ${r.json?.error?.code || ''}, account created: ${exists ? 'yes' : 'no'}`, false, true);
    } else {
        record('ST2b', 'Sign up with a FAKE Turnstile token', '403 BOT_CHECK_FAILED, no account in Cognito',
            `${r.status} ${r.json?.error?.code || ''}, account created: ${exists ? 'yes' : 'no'}`, r.status === 403 && !exists);
    }
}

async function st3(a, b) {
    console.log('\n== ST3  User B cannot see or change user A\'s data (answer is 404, as if it did not exist)');
    const year = new Date().getUTCFullYear() + 1;
    const created = await call('POST', '/api/goals', {
        token: a.access, body: { title: 'ST3 private goal of user A', category: 'Learning', year, deadline: `${year}-12-31` }
    });
    if (created.status !== 201) {
        record('ST3', 'Set-up: user A creates a goal', '201', `${created.status} ${JSON.stringify(created.json)}`, false);
        return;
    }
    const goalId = created.json.goalId;
    cleanup.push(() => call('DELETE', `/api/goals/${goalId}`, { token: a.access }));

    let r = await call('GET', `/api/goals/${goalId}`, { token: b.access });
    record('ST3', 'B opens A\'s goal', '404', r.status, r.status === 404);
    r = await call('PATCH', `/api/goals/${goalId}`, { token: b.access, body: { title: 'changed by user B' } });
    record('ST3b', 'B edits A\'s goal', '404', r.status, r.status === 404);
    r = await call('POST', `/api/goals/${goalId}/transitions`, { token: b.access, body: { to: 'Abandoned', reason: 'user B tries to abandon it' } });
    record('ST3c', 'B changes the state of A\'s goal', '404', r.status, r.status === 404);
    r = await call('DELETE', `/api/goals/${goalId}`, { token: b.access });
    record('ST3d', 'B deletes A\'s goal', '404', r.status, r.status === 404);
    r = await call('GET', `/api/goals?year=${year}`, { token: b.access });
    const leaked = (Array.isArray(r.json) ? r.json : []).some((g) => g.goalId === goalId);
    record('ST3e', 'B\'s goal list does not include A\'s goal', 'not listed', leaked ? 'LISTED' : 'not listed', r.status === 200 && !leaked);

    // Key Results Service (Amr Shalaby), when it is deployed
    const health = await call('GET', '/api/key-results/health');
    if (health.status !== 200) {
        record('ST3k', 'Key results part', 'run when okr18-keyresults-service is deployed', `health ${health.status}`, false, true);
    } else {
        const kr = await call('POST', `/api/goals/${goalId}/key-results`, {
            token: a.access, body: { title: 'ST3 key result of A', type: 'number', unit: 'books', start: 0, target: 10, weight: 1 }
        });
        if (kr.status !== 201) {
            record('ST3k', 'Set-up: user A adds a key result', '201', `${kr.status} ${JSON.stringify(kr.json)}`, false);
        } else {
            const krId = kr.json.krId;
            cleanup.push(() => call('DELETE', `/api/key-results/${krId}`, { token: a.access }));   // cleanup runs newest first: before the goal
            r = await call('GET', `/api/goals/${goalId}/key-results`, { token: b.access });
            record('ST3k', 'B lists the key results of A\'s goal', '404', r.status, r.status === 404);
            r = await call('GET', `/api/key-results/${krId}`, { token: b.access });
            record('ST3l', 'B opens A\'s key result', '404', r.status, r.status === 404);
            r = await call('PATCH', `/api/key-results/${krId}`, { token: b.access, body: { title: 'changed by user B' } });
            record('ST3m', 'B edits A\'s key result', '404', r.status, r.status === 404);
            r = await call('DELETE', `/api/key-results/${krId}`, { token: b.access });
            record('ST3n', 'B deletes A\'s key result', '404', r.status, r.status === 404);
            r = await call('GET', `/api/key-results/${krId}`, { token: a.access });
            record('ST3o', 'A\'s key result is unchanged', 'title "ST3 key result of A"', r.json?.title, r.json?.title === 'ST3 key result of A');
        }
    }

    r = await call('GET', `/api/goals/${goalId}`, { token: a.access });
    record('ST3p', 'A\'s goal is unchanged after all of B\'s attempts', 'Draft, title "ST3 private goal of user A"',
        `${r.json?.status}, title "${r.json?.title}"`, r.json?.status === 'Draft' && r.json?.title === 'ST3 private goal of user A');
    console.log('            (the check-ins part of ST3 is in okr18-checkins-service)');
}

async function st5(a) {
    console.log('\n== ST5  Too much data, too many requests');
    const big = JSON.stringify({ title: 'x'.repeat(50 * 1024), category: 'Learning' });
    let r = await call('POST', '/api/goals', { token: a.access, raw: big, headers: { 'content-type': 'application/json' } });
    record('ST5', 'POST /api/goals with a 50 kB body', '413 PAYLOAD_TOO_LARGE', `${r.status} ${r.json?.error?.code || ''}`, r.status === 413);

    r = await call('POST', '/api/goals', { token: a.access, raw: 'title=hello', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    record('ST5b', 'POST /api/goals with a form body instead of JSON', '415', r.status, r.status === 415);

    const started = Date.now();
    const statuses = await Promise.all(Array.from({ length: 50 }, () => call('GET', '/api/goals/health').then((x) => x.status, () => 'error')));
    const counts = statuses.reduce((m, s) => ({ ...m, [s]: (m[s] || 0) + 1 }), {});
    record('ST5c', `50 requests at once (${Date.now() - started} ms)`,
        'some 429 on real AWS (throttling 10/s, burst 20). Floci accepts the setting but does not enforce it',
        JSON.stringify(counts), false, true);
}

async function st8(testSecret) {
    console.log('\n== ST8  Wrong passwords lock the account for 15 minutes');
    if (!testSecret) {
        record('ST8', '10 wrong passwords', 'run from the website: this script cannot pass a real Turnstile check',
            'skipped (real Turnstile secret in use)', false, true);
        return;
    }
    const email = await makeUser('lock');
    const seen = [];
    for (let i = 1; i <= 10; i += 1) {
        const r = await call('POST', '/api/auth/login', { body: { email, password: `Wrong-pass-${i}`, turnstileToken: DUMMY_TURNSTILE_TOKEN } });
        seen.push(r.status);
    }
    const firstLock = seen.indexOf(429) + 1;
    record('ST8', '10 wrong passwords for one account', '401 for tries 1-5, then 429 TOO_MANY_ATTEMPTS',
        `${seen.join(' ')}  (locked from try ${firstLock || 'never'})`, seen.slice(0, 5).every((s) => s === 401) && seen.slice(5).every((s) => s === 429));

    const right = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD, turnstileToken: DUMMY_TURNSTILE_TOKEN } });
    record('ST8b', 'Then the RIGHT password', '429 (still locked), Retry-After about 900 seconds',
        `${right.status} ${right.json?.error?.code || ''}, Retry-After ${right.retryAfter || '-'}`, right.status === 429 && !right.json?.accessToken);

    const unknown = await call('POST', '/api/auth/login', { body: { email: `st-nobody-${RUN}@okr18.test`, password: 'Wrong-pass-0', turnstileToken: DUMMY_TURNSTILE_TOKEN } });
    record('ST8c', 'Unknown email gets the same answer as a wrong password', '401 INVALID_CREDENTIALS',
        `${unknown.status} ${unknown.json?.error?.code || ''}`, unknown.status === 401 && unknown.json?.error?.code === 'INVALID_CREDENTIALS');
}

// ---------- run ----------
async function main() {
    console.log(`OKR18 security tests  ${new Date().toISOString()}`);
    console.log(`API ${API}\n`);
    const health = await call('GET', '/api/goals/health').catch(() => null);
    if (!health || health.status !== 200) {
        console.error('The Goals API is not answering. Is Floci running, and did bash infra/deploy-all.sh finish?');
        process.exit(1);
    }

    // Which Turnstile secret is in use? Compared here, never printed.
    let testSecret = false;
    try {
        const sm = new SecretsManagerClient(cfg);
        const s = await sm.send(new GetSecretValueCommand({ SecretId: vars.TURNSTILE_SECRET_ARN }));
        testSecret = s.SecretString === TEST_SECRET_ALWAYS_PASSES;
    } catch { /* treat as real secret */ }
    console.log(`Turnstile secret: ${testSecret ? 'Cloudflare test secret (always passes)' : 'real secret'}`);

    const a = await tokensFor(await makeUser('a'));
    const b = await tokensFor(await makeUser('b'));

    try {
        await st1(a);
        await st2(testSecret);
        await st3(a, b);
        await st5(a);
        await st8(testSecret);
    } finally {
        console.log('\nCleaning up test users and data...');
        for (const undo of cleanup.reverse()) { try { await undo(); } catch { /* already gone */ } }
    }

    const n = (s) => results.filter((r) => r.status === s).length;
    console.log(`\nSummary: ${n('PASS')} PASS, ${n('FAIL')} FAIL, ${n('INFO')} INFO`);
    console.log('INFO = cannot be proven on Floci; shown as configuration in the report.');
    if (n('FAIL')) process.exitCode = 1;
}

main().catch((e) => { console.error('Stopped:', e.name, e.message); process.exit(1); });
