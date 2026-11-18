// Auth endpoint tests with fake Cognito and fake Turnstile (security tests ST1, ST2, ST8 for auth)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/createApp');
const { createTurnstile, BotCheckUnavailable } = require('../src/turnstile');
const { createLoginAttempts, memoryStore, nextState } = require('../src/loginAttempts');

function fakeCognito() {
    const users = new Map();
    return {
        users,
        async signUp(email, password) {
            if (users.has(email)) { const e = new Error('exists'); e.name = 'UsernameExistsException'; throw e; }
            users.set(email, password); return 'sub-1';
        },
        async logIn(email, password) {
            if (users.get(email) !== password) { const e = new Error('no'); e.name = users.has(email) ? 'NotAuthorizedException' : 'UserNotFoundException'; throw e; }
            return { AccessToken: 'token-a', ExpiresIn: 3600 };
        },
        async logOut() {}
    };
}
const fakeTurnstile = (state = { down: false }) => ({
    state,
    async verify(token) { if (state.down) throw new BotCheckUnavailable('down'); return token === 'human-token-ok'; }
});
const fakeVerify = async (t) => { if (t !== 'token-a') throw new Error('bad'); return { sub: 'user-a', 'cognito:groups': ['user'] }; };

function setup() {
    const cognito = fakeCognito(); const turnstile = fakeTurnstile();
    const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
    const attempts = createLoginAttempts({ store: memoryStore(), now: () => clock.t });
    const server = createApp({ cognito, turnstile, verify: fakeVerify, attempts }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const call = async (method, path, body, token) => {
        const headers = { 'content-type': 'application/json' };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { cognito, turnstile, server, call, clock };
}
const human = { turnstileToken: 'human-token-ok' };

test('ST2: sign-up without a valid Turnstile token is refused before Cognito', async (t) => {
    const { server, call, cognito } = setup(); t.after(() => server.close());
    const r = await call('POST', '/signup', { email: 'a@okr18.test', password: 'Strong-pass-1', turnstileToken: 'bot-made-this-up' });
    assert.deepEqual([r.status, r.body.error.code], [403, 'BOT_CHECK_FAILED']);
    assert.equal(cognito.users.size, 0);
});

test('sign-up: 201, weak password 400, duplicate 409, bad email 400', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    assert.equal((await call('POST', '/signup', { email: 'A@OKR18.test ', password: 'Strong-pass-1', ...human })).status, 201);
    assert.equal((await call('POST', '/signup', { email: 'b@okr18.test', password: 'weakpass', ...human })).status, 400);
    assert.equal((await call('POST', '/signup', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human })).body.error.code, 'EMAIL_TAKEN');
    assert.equal((await call('POST', '/signup', { email: 'not-an-email', password: 'Strong-pass-1', ...human })).status, 400);
});

test('login: right password 200 with token; wrong password and unknown email look the same', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    await call('POST', '/signup', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human });
    const ok = await call('POST', '/login', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accessToken, 'token-a');
    const wrong = await call('POST', '/login', { email: 'a@okr18.test', password: 'Wrong-pass-1', ...human });
    const unknown = await call('POST', '/login', { email: 'nobody@okr18.test', password: 'Wrong-pass-1', ...human });
    assert.deepEqual([wrong.status, wrong.body], [unknown.status, unknown.body]);
    assert.equal(wrong.status, 401);
});

test('ST8: 5 wrong passwords lock the account for 15 minutes, even for the right password', async (t) => {
    const { server, call, clock } = setup(); t.after(() => server.close());
    await call('POST', '/signup', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human });
    for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/login', { email: 'a@okr18.test', password: 'Wrong-pass-1', ...human })).status, 401);
    assert.equal((await call('POST', '/login', { email: 'a@okr18.test', password: 'Wrong-pass-1', ...human })).status, 401);   // 5th: locks
    const locked = await call('POST', '/login', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human });
    assert.deepEqual([locked.status, locked.body.error.code], [429, 'TOO_MANY_ATTEMPTS']);
    clock.t += 16 * 60 * 1000;                                                                                             // lock expires
    assert.equal((await call('POST', '/login', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human })).status, 200);
});

test('lockout rule: failures outside the 15-minute window start a new count', () => {
    const t0 = 1_000_000;
    let row = nextState(null, t0);
    assert.deepEqual([row.failures, row.lockedUntil], [1, 0]);
    for (let i = 0; i < 3; i++) row = nextState(row, t0 + 1000);
    assert.equal(row.failures, 4);
    assert.equal(nextState(row, t0 + 16 * 60 * 1000).failures, 1);          // window passed: start again
    assert.ok(nextState(row, t0 + 2000).lockedUntil > t0);                 // 5th inside the window: locked
});

test('Turnstile down: 503, never skipped', async (t) => {
    const { server, call, turnstile, cognito } = setup(); t.after(() => server.close());
    turnstile.state.down = true;
    assert.equal((await call('POST', '/signup', { email: 'a@okr18.test', password: 'Strong-pass-1', ...human })).status, 503);
    assert.equal(cognito.users.size, 0);
});

test('ST1: me and logout need a valid token', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    assert.equal((await call('GET', '/me')).status, 401);
    assert.equal((await call('GET', '/me', null, 'forged')).status, 401);
    const me = await call('GET', '/me', null, 'token-a');
    assert.deepEqual(me.body, { userId: 'user-a', groups: ['user'] });
    assert.equal((await call('POST', '/logout', null, 'token-a')).status, 204);
});

test('Turnstile client: sends the secret from Secrets Manager and reads success', async () => {
    const sent = [];
    const fakeSm = { send: async () => ({ SecretString: 'the-secret' }) };
    const ts = createTurnstile({ secretId: 'arn:x', client: fakeSm, fetchFn: async (url, opts) => { sent.push([url, String(opts.body)]); return { ok: true, json: async () => ({ success: opts.body.get('response') === 'good-token-123' }) }; } });
    assert.equal(await ts.verify('good-token-123', '1.2.3.4'), true);
    assert.equal(await ts.verify('bad-token-1234'), false);
    assert.equal(await ts.verify('x'), false);                       // too short: no call at all
    assert.equal(sent.length, 2);
    assert.match(sent[0][1], /secret=the-secret/);
    const down = createTurnstile({ secretId: 'arn:x', client: fakeSm, fetchFn: async () => { throw new Error('offline'); } });
    await assert.rejects(down.verify('good-token-123'), BotCheckUnavailable);
});
