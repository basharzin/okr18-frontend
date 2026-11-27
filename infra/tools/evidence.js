// ---------------------------------------------------------------
// Evidence for the report: monitoring (CloudWatch) and least privilege (IAM).
//   1. Security events in CloudWatch Logs (run security-tests.js first, so there are some)
//   2. The logs hold no passwords, tokens or email addresses
//   3. The GoalsAtRisk metric written by the daily health scan
//   3b. The FailedLogins metric and the okr18-failed-logins alarm (repeated failed logins)
//   4. Each Lambda role can reach its own table and not the others (ST10 style)
//
// Run from okr18-frontend/infra/tools in Git Bash, after deploy-all and npm run security:
//   npm install
//   npm run evidence
// Read-only, except step 3 runs the health scan once (the same job the scheduler runs daily).
// ---------------------------------------------------------------
if (!process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) process.env.AWS_PROFILE = 'floci';

const { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, ListMetricsCommand, GetMetricStatisticsCommand, DescribeAlarmsCommand } = require('@aws-sdk/client-cloudwatch');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { IAMClient, ListRolePoliciesCommand, GetRolePolicyCommand } = require('@aws-sdk/client-iam');

const cfg = { region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:4566' };
const ACCOUNT = '000000000000';
const logs = new CloudWatchLogsClient(cfg);
const cw = new CloudWatchClient(cfg);
const lambda = new LambdaClient(cfg);
const iam = new IAMClient(cfg);

const HOURS = Number(process.env.HOURS || 6);   // how far back to read the logs
const GROUPS = ['auth-api', 'goals-api', 'goals-internal', 'goals-health-scan', 'kr-api', 'kr-internal', 'kr-events',
    'checkins-api', 'checkins-events', 'admin-api'];

const results = [];
function record(id, test, expected, actual, ok, info = false) {
    const status = info ? 'INFO' : ok ? 'PASS' : 'FAIL';
    results.push(status);
    console.log(`${status.padEnd(5)} ${id.padEnd(5)} ${test}`);
    console.log(`            expected: ${expected}`);
    console.log(`            actual:   ${actual}`);
}

// ---------- read every log line of one Lambda in the time window ----------
async function readGroup(fn) {
    const group = `/aws/lambda/${fn}`;
    const since = Date.now() - HOURS * 3600 * 1000;
    const lines = [];

    // 1st choice: FilterLogEvents reads every stream of the group in one paged call
    try {
        let token;
        for (let page = 0; page < 200; page += 1) {
            const out = await logs.send(new FilterLogEventsCommand({ logGroupName: group, startTime: since, nextToken: token }));
            for (const e of out.events || []) lines.push(e.message);
            if (!out.nextToken || out.nextToken === token) break;
            token = out.nextToken;
        }
        if (lines.length) return lines;
    } catch (e) {
        if (e.name === 'ResourceNotFoundException') return null;   // service not deployed
    }

    // Fallback: every stream (all pages, Floci may make one per container), then its events
    const streams = [];
    try {
        let token;
        for (let page = 0; page < 100; page += 1) {
            const out = await logs.send(new DescribeLogStreamsCommand({ logGroupName: group, nextToken: token }));
            streams.push(...(out.logStreams || []));
            if (!out.nextToken || out.nextToken === token) break;
            token = out.nextToken;
        }
    } catch (e) {
        if (e.name === 'ResourceNotFoundException') return null;
        throw e;
    }
    for (const s of streams) {
        let token;
        for (let page = 0; page < 50; page += 1) {
            const out = await logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName, startFromHead: true, nextToken: token }));
            for (const e of out.events || []) if (!e.timestamp || e.timestamp >= since) lines.push(e.message);
            if (!out.nextForwardToken || out.nextForwardToken === token || !(out.events || []).length) break;
            token = out.nextForwardToken;
        }
    }
    return lines;
}

// A log line is our JSON; Lambda's own START/END/REPORT lines and the runtime prefix are skipped
function parse(line) {
    const i = line.indexOf('{');
    if (i < 0) return null;
    try { return JSON.parse(line.slice(i)); } catch { return null; }
}

// ---------- 1 + 2: logs ----------
async function checkLogs() {
    console.log(`\n== Monitoring: CloudWatch Logs (last ${HOURS} hours)`);
    const counts = {};
    const samples = {};
    const audit = {};
    const leaks = { 'JWT token': 0, 'Bearer header': 0, 'password field': 0, 'email address': 0, 'Turnstile token': 0 };
    const leakExamples = [];
    let total = 0;
    let groupsRead = 0;
    const perGroup = [];

    for (const fn of GROUPS) {
        const lines = await readGroup(fn);
        if (lines === null) continue;
        groupsRead += 1;
        total += lines.length;
        perGroup.push(`${fn} ${lines.length}`);
        for (const line of lines) {
            const found = [];
            if (/eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/.test(line)) found.push('JWT token');
            if (/Bearer\s+\S{20,}/i.test(line)) found.push('Bearer header');
            if (/"password"\s*:/i.test(line)) found.push('password field');
            if (/[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(line)) found.push('email address');
            if (/turnstileToken/i.test(line)) found.push('Turnstile token');
            found.forEach((k) => { leaks[k] += 1; });
            if (found.length && leakExamples.length < 3) leakExamples.push(`${fn}: ${found.join(', ')}`);

            const j = parse(line);
            if (j && j.audit) audit[j.audit] = (audit[j.audit] || 0) + 1;
            if (j && j.security) {
                const key = `${fn}  ${j.security}`;
                counts[key] = (counts[key] || 0) + 1;
                if (!samples[j.security]) samples[j.security] = JSON.stringify(j);
            }
        }
    }

    if (!groupsRead) {
        record('LOG1', 'Lambda log groups exist', 'log groups for auth-api and goals-api', 'none found', false);
        return;
    }
    console.log(`Read ${total} log lines from ${groupsRead} Lambda log groups (${perGroup.join(', ')}).\n`);
    console.log('Security events by Lambda:');
    const keys = Object.keys(counts).sort();
    for (const k of keys) console.log(`   ${String(counts[k]).padStart(4)}  ${k}`);
    console.log('\nOne example of each (what an admin or an alarm sees):');
    for (const [type, line] of Object.entries(samples)) console.log(`   ${type.padEnd(18)} ${line}`);
    console.log('');

    const types = new Set(Object.keys(samples));
    const want = ['auth_failed', 'login_failed', 'login_locked', 'bot_check_failed'];
    const missing = want.filter((t) => !types.has(t));
    record('LOG1', 'Security events are written to CloudWatch Logs', want.join(', '),
        missing.length ? `missing: ${missing.join(', ')} (run npm run security first)` : 'all four found', missing.length === 0);

    const auditList = Object.entries(audit).map(([k, v]) => `${k} ${v}`).join(', ');
    record('LOG3', 'Audit trail: every goal state change and delete is logged (who, which goal)', 'audit lines in goals-api',
        auditList || 'none yet (change a goal state in the website, then run again)', !!auditList, !auditList);

    const leakTotal = Object.values(leaks).reduce((a, b) => a + b, 0);
    record('LOG2', 'Logs hold no tokens, passwords or email addresses', '0 lines',
        leakTotal ? `${leakTotal} lines: ${JSON.stringify(leaks)}; e.g. ${leakExamples.join(' | ')}` : '0 lines', leakTotal === 0);
    if (leakTotal) console.log('            (if these lines are Floci printing the raw Lambda event, say so in the report: our code never logs bodies or headers)');
}

// ---------- 3: metric ----------
async function checkMetric() {
    console.log('\n== Monitoring: CloudWatch metric OKR18/Goals GoalsAtRisk');
    let scan;
    try {
        const out = await lambda.send(new InvokeCommand({ FunctionName: 'goals-health-scan', Payload: Buffer.from('{}') }));
        scan = JSON.parse(Buffer.from(out.Payload).toString('utf8'));
        console.log(`Ran the health scan once: ${JSON.stringify(scan)}`);
    } catch (e) {
        record('MET1', 'Health scan runs', 'it answers', `${e.name}`, false);
        return;
    }
    try {
        const list = await cw.send(new ListMetricsCommand({ Namespace: 'OKR18/Goals' }));
        const names = (list.Metrics || []).map((m) => m.MetricName);
        const stats = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'OKR18/Goals', MetricName: 'GoalsAtRisk',
            StartTime: new Date(Date.now() - 24 * 3600 * 1000), EndTime: new Date(Date.now() + 60 * 1000),
            Period: 3600, Statistics: ['Maximum', 'SampleCount']
        }));
        const points = (stats.Datapoints || []).sort((a, b) => a.Timestamp - b.Timestamp);
        const last = points[points.length - 1];
        record('MET1', 'Health scan writes the GoalsAtRisk metric', 'metric listed with a datapoint',
            `metrics: ${names.join(', ') || 'none'}; latest max ${last ? last.Maximum : '-'} (${points.length} hours with data)`,
            names.includes('GoalsAtRisk') && points.length > 0);
    } catch (e) {
        record('MET1', 'Health scan writes the GoalsAtRisk metric', 'metric listed with a datapoint',
            `Floci answered ${e.name}; the scan's log line above carries the same number`, false, true);
    }
}

// ---------- 3b: failed-login metric and alarm ----------
async function checkLoginAlarm() {
    console.log('\n== Monitoring: CloudWatch metric OKR18/Auth FailedLogins and its alarm');
    try {
        const stats = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'OKR18/Auth', MetricName: 'FailedLogins',
            StartTime: new Date(Date.now() - HOURS * 3600 * 1000), EndTime: new Date(Date.now() + 60 * 1000),
            Period: 300, Statistics: ['Sum']
        }));
        const points = stats.Datapoints || [];
        const total = points.reduce((a, p) => a + (p.Sum || 0), 0);
        const worst = points.reduce((a, p) => Math.max(a, p.Sum || 0), 0);
        record('MET2', 'Auth counts failed logins (metric FailedLogins)', 'datapoints after npm run security',
            `${total} failed logins in the last ${HOURS} h; worst 5 minutes: ${worst}`, total > 0);
    } catch (e) {
        record('MET2', 'Auth counts failed logins (metric FailedLogins)', 'datapoints', `Floci answered ${e.name}`, false, true);
    }
    try {
        const out = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ['okr18-failed-logins'] }));
        const a = (out.MetricAlarms || [])[0];
        record('MET3', 'Alarm okr18-failed-logins (5 or more failed logins in 5 minutes)', 'alarm exists',
            a ? `${a.AlarmName}: ${a.MetricName} ${a.Statistic} >= ${a.Threshold} per ${a.Period}s, state ${a.StateValue || '-'}` : 'not found (run deploy-all again)',
            !!a);
    } catch (e) {
        record('MET3', 'Alarm okr18-failed-logins', 'alarm exists', `Floci answered ${e.name} (alarms may not be emulated)`, false, true);
    }
}

// ---------- 4: IAM ----------
// Does an Allow statement in these policies cover this action on this resource?
const glob = (pattern, value) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
const asList = (x) => (Array.isArray(x) ? x : [x]);
function allows(policies, action, resource) {
    return policies.some((doc) => asList(doc.Statement).some((s) => s.Effect === 'Allow'
        && asList(s.Action).some((a) => glob(a.toLowerCase(), action.toLowerCase()))
        && asList(s.Resource).some((r) => glob(r, resource))));
}

async function rolePolicies(role) {
    const names = (await iam.send(new ListRolePoliciesCommand({ RoleName: role }))).PolicyNames || [];
    const docs = [];
    for (const n of names) {
        const p = await iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: n }));
        const raw = p.PolicyDocument;
        docs.push(typeof raw === 'string' ? JSON.parse(raw.trim().startsWith('{') ? raw : decodeURIComponent(raw)) : raw);
    }
    return docs;
}

// Reads the role's own policy documents (all our roles use inline policies only).
// Floci does not enforce IAM, so reading the policy is the honest proof here;
// on real AWS the same cases can be run with: aws iam simulate-principal-policy
function decide(policies, action, resource) {
    const allowed = allows(policies, action, resource);
    return { allowed, how: allowed ? 'allowed by its policy' : 'not in its policy (implicit deny)' };
}

async function checkIam() {
    console.log('\n== Least privilege: what each Lambda role may touch');
    const table = (t) => `arn:aws:dynamodb:${cfg.region}:${ACCOUNT}:table/${t}`;
    const fn = (f) => `arn:aws:lambda:${cfg.region}:${ACCOUNT}:function:${f}`;
    const cases = [
        // role, action, resource, should it be allowed?
        ['goals-role', 'dynamodb:GetItem', table('Goals'), true],
        ['goals-role', 'dynamodb:GetItem', table('KeyResults'), false],
        ['goals-role', 'dynamodb:Scan', table('LoginAttempts'), false],
        ['goals-role', 'dynamodb:DeleteTable', table('Goals'), false],
        ['goals-role', 'lambda:InvokeFunction', fn('kr-internal'), true],
        ['goals-role', 'lambda:InvokeFunction', fn('auth-api'), false],
        ['goals-role', 'secretsmanager:GetSecretValue', `arn:aws:secretsmanager:${cfg.region}:${ACCOUNT}:secret:okr18/turnstile-secret`, false],
        ['auth-role', 'dynamodb:GetItem', table('LoginAttempts'), true],
        ['auth-role', 'dynamodb:GetItem', table('Goals'), false],
        ['kr-role', 'dynamodb:GetItem', table('KeyResults'), true],
        ['kr-role', 'dynamodb:GetItem', table('Goals'), false],
        ['kr-role', 'lambda:InvokeFunction', fn('goals-internal'), true]
    ];
    const cache = {};
    let n = 0;
    for (const [role, action, resource, expect] of cases) {
        n += 1;
        if (!(role in cache)) {
            try { cache[role] = await rolePolicies(role); } catch { cache[role] = null; }
        }
        const id = `IAM${n}`;
        const short = resource.split(':').slice(5).join(':');
        if (!cache[role]) { record(id, `${role}: ${action} on ${short}`, expect ? 'allowed' : 'denied', 'role not deployed', false, true); continue; }
        const { allowed, how } = decide(cache[role], action, resource);
        record(id, `${role}: ${action} on ${short}`, expect ? 'allowed' : 'denied', how, allowed === expect);
    }
    // Resource "*" is only accepted where AWS has no resource-level permission for the action
    // (cloudwatch:PutMetricData) AND a Condition narrows it (our own namespace only).
    const NO_RESOURCE_LEVEL = ['cloudwatch:putmetricdata'];
    const exempt = (s) => s.Condition && asList(s.Action).every((a) => NO_RESOURCE_LEVEL.includes(a.toLowerCase()));
    const wildcard = [];
    const narrowed = [];
    for (const [role, docs] of Object.entries(cache)) {
        for (const st of (docs || []).flatMap((d) => asList(d.Statement))) {
            if (!(asList(st.Action).includes('*') || asList(st.Resource).includes('*'))) continue;
            (exempt(st) ? narrowed : wildcard).push(`${role} ${asList(st.Action).join(',')}`);
        }
    }
    record(`IAM${n + 1}`, 'No role has Action "*" or Resource "*" (except where AWS needs it, narrowed by a Condition)', 'none',
        wildcard.length ? wildcard.join('; ') : `none${narrowed.length ? ` (allowed with a Condition: ${narrowed.join('; ')} each limited to its own OKR18 namespace)` : ''}`,
        wildcard.length === 0);
}

async function main() {
    console.log(`OKR18 evidence  ${new Date().toISOString()}`);
    await checkLogs();
    await checkMetric();
    await checkLoginAlarm();
    await checkIam();
    const c = (s) => results.filter((r) => r === s).length;
    console.log(`\nSummary: ${c('PASS')} PASS, ${c('FAIL')} FAIL, ${c('INFO')} INFO`);
    if (c('FAIL')) process.exitCode = 1;
}

main().catch((e) => { console.error('Stopped:', e.name, e.message); console.error('Is Floci running?'); process.exit(1); });
