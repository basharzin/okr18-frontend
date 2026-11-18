// ---------------------------------------------------------------
// Account lockout (threat T1, test ST8).
// Floci's Cognito does not lock an account after wrong passwords, so the
// auth service does it: 5 failures within 15 minutes lock that email for
// 15 minutes. Stored in DynamoDB (LoginAttempts), keyed by a hash of the
// email, so the table never holds an email address. A TTL attribute lets
// DynamoDB delete old rows by itself.
// ---------------------------------------------------------------
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

// The rule itself, separate from storage so it is easy to test
function nextState(row, now) {
    const fresh = !row || now - row.windowStart > WINDOW_MS;
    const failures = fresh ? 1 : row.failures + 1;
    const windowStart = fresh ? now : row.windowStart;
    const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : 0;
    return { failures, windowStart, lockedUntil };
}

function memoryStore() {
    const rows = new Map();
    return {
        async get(id) { return rows.get(id) || null; },
        async put(row) { rows.set(row.id, row); },
        async remove(id) { rows.delete(id); }
    };
}

function dynamoStore(table, client) {
    const db = client || DynamoDBDocumentClient.from(new DynamoDBClient({}));
    return {
        async get(id) { return (await db.send(new GetCommand({ TableName: table, Key: { id } }))).Item || null; },
        async put(row) { await db.send(new PutCommand({ TableName: table, Item: row })); },
        async remove(id) { await db.send(new DeleteCommand({ TableName: table, Key: { id } })); }
    };
}

function createLoginAttempts({ table = process.env.LOGIN_ATTEMPTS_TABLE, store, now = () => Date.now() } = {}) {
    if (!store) {
        if (!table && process.env.NODE_ENV === 'production') throw new Error('LOGIN_ATTEMPTS_TABLE is not set.');
        store = table ? dynamoStore(table) : memoryStore();
    }
    return {
        // ms left on the lock, or 0
        async lockedFor(id) {
            const row = await store.get(id);
            const left = row?.lockedUntil ? row.lockedUntil - now() : 0;
            return left > 0 ? left : 0;
        },
        async recordFailure(id) {
            const t = now();
            const state = nextState(await store.get(id), t);
            await store.put({ id, ...state, ttl: Math.ceil((t + WINDOW_MS + LOCK_MS) / 1000) });
            return state;
        },
        async clear(id) { await store.remove(id); }
    };
}

module.exports = { createLoginAttempts, nextState, memoryStore, MAX_FAILURES, WINDOW_MS, LOCK_MS };
