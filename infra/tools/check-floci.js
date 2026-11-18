// ---------------------------------------------------------------
// Task 5: which AWS features of our design does Floci really support?
// Creates small throw-away resources (names start with "probe-"), tries
// each feature, prints PASS / PARTIAL / FAIL, then deletes what it made.
//
// Run from okr18-frontend/infra/tools in Git Bash, with Floci running:
//   npm install
//   AWS_PROFILE=floci node check-floci.js
// Only one thing is fetched from the internet: nothing. Everything stays on Floci.
// ---------------------------------------------------------------
// PowerShell does not read Git Bash's ~/.bashrc, so default to the Floci profile
if (!process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) process.env.AWS_PROFILE = 'floci';

const zlib = require('zlib');
const { CognitoIdentityProviderClient, ...cog } = require('@aws-sdk/client-cognito-identity-provider');
const { IAMClient, CreateRoleCommand, DeleteRoleCommand } = require('@aws-sdk/client-iam');
const { LambdaClient, CreateFunctionCommand, InvokeCommand, AddPermissionCommand, DeleteFunctionCommand, waitUntilFunctionActiveV2 } = require('@aws-sdk/client-lambda');
const { ApiGatewayV2Client, ...gw } = require('@aws-sdk/client-apigatewayv2');
const { SNSClient, CreateTopicCommand, SubscribeCommand, PublishCommand, DeleteTopicCommand } = require('@aws-sdk/client-sns');
const { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, DeleteQueueCommand } = require('@aws-sdk/client-sqs');
const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const { SESv2Client, CreateEmailIdentityCommand, SendEmailCommand, DeleteEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { WAFV2Client, CreateWebACLCommand, DeleteWebACLCommand } = require('@aws-sdk/client-wafv2');
const { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, DeleteSecretCommand } = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION || 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';
const cfg = { region, endpoint };
const ACCOUNT = '000000000000';
const RUN = Date.now().toString(36);
const results = [];
const cleanup = [];

function record(feature, status, note) {
    results.push({ feature, status, note });
    const mark = { PASS: 'PASS   ', PARTIAL: 'PARTIAL', FAIL: 'FAIL   ', INFO: 'INFO   ' }[status];
    console.log(`${mark}  ${feature}${note ? `  (${note})` : ''}`);
}
async function probe(feature, fn) {
    try { await fn(); } catch (e) { record(feature, 'FAIL', `${e.name}: ${String(e.message).slice(0, 120)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

// A tiny Lambda that echoes the caller and the authorizer claims, zipped in memory
function zipOne(name, text) {
    const data = Buffer.from(text); const packed = zlib.deflateRawSync(data);
    let c = 0xffffffff; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    const crc = (c ^ 0xffffffff) >>> 0; const n = Buffer.from(name);
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(packed.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0x0314, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + packed.length, 16);
    return Buffer.concat([loc, n, packed, cen, n, end]);
}
const ECHO = `exports.handler = async (event) => ({ statusCode: 200, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true, sub: event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt ? event.requestContext.authorizer.jwt.claims.sub : null }) });`;

async function main() {
    console.log(`Checking Floci at ${endpoint} (${region}), run ${RUN}\n`);
    try {
        await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    } catch {
        console.error(`Floci is not answering at ${endpoint}.`);
        console.error('1. Open Docker Desktop and wait for "Engine running".');
        console.error('2. From okr18-frontend: docker compose -f infra/floci/docker-compose.yml up -d');
        console.error('3. Check: docker ps   (a container named floci, status Up)');
        process.exit(1);
    }
    const ctx = {};

    // 1. Cognito: pool, client, groups, login, token contents, JWKS
    const cognito = new CognitoIdentityProviderClient(cfg);
    await probe('Cognito user pool + login', async () => {
        const pool = await cognito.send(new cog.CreateUserPoolCommand({ PoolName: `probe-${RUN}`, Policies: { PasswordPolicy: { MinimumLength: 8 } } }));
        ctx.poolId = pool.UserPool.Id;
        cleanup.push(() => cognito.send(new cog.DeleteUserPoolCommand({ UserPoolId: ctx.poolId })));
        const client = await cognito.send(new cog.CreateUserPoolClientCommand({
            UserPoolId: ctx.poolId, ClientName: 'probe', ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']
        }));
        ctx.clientId = client.UserPoolClient.ClientId;
        await cognito.send(new cog.CreateGroupCommand({ UserPoolId: ctx.poolId, GroupName: 'admin' }));
        await cognito.send(new cog.AdminCreateUserCommand({ UserPoolId: ctx.poolId, Username: 'probe@okr18.test', MessageAction: 'SUPPRESS' }));
        await cognito.send(new cog.AdminSetUserPasswordCommand({ UserPoolId: ctx.poolId, Username: 'probe@okr18.test', Password: 'Probe-pass-123', Permanent: true }));
        await cognito.send(new cog.AdminAddUserToGroupCommand({ UserPoolId: ctx.poolId, Username: 'probe@okr18.test', GroupName: 'admin' }));
        const auth = await cognito.send(new cog.InitiateAuthCommand({
            ClientId: ctx.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: 'probe@okr18.test', PASSWORD: 'Probe-pass-123' }
        }));
        ctx.token = auth.AuthenticationResult.AccessToken;
        const claims = decode(ctx.token);
        ctx.issuer = claims.iss;
        const groups = claims['cognito:groups'] || [];
        record('Cognito user pool + login', 'PASS', `issuer ${claims.iss}`);
        record('Cognito groups in the token', groups.includes('admin') ? 'PASS' : 'FAIL', `cognito:groups = ${JSON.stringify(groups)}`);
        record('Token has client_id', claims.client_id === ctx.clientId ? 'PASS' : 'PARTIAL', `client_id ${claims.client_id}`);
    });

    if (ctx.issuer) {
        await probe('JWKS public keys', async () => {
            // "floci" only resolves inside Docker; from the PC the same keys are on localhost
            const url = `${ctx.issuer.replace(/\/$/, '').replace('//floci:', '//localhost:')}/.well-known/jwks.json`;
            const res = await fetch(url);
            const body = await res.json();
            record('JWKS public keys', body.keys?.length ? 'PASS' : 'FAIL', `${url} -> ${body.keys?.length || 0} keys`);
            ctx.jwks = url;
        });
        await probe('Cognito blocks repeated wrong passwords', async () => {
            let lastError = '';
            for (let i = 0; i < 8; i++) {
                try {
                    await cognito.send(new cog.InitiateAuthCommand({ ClientId: ctx.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: 'probe@okr18.test', PASSWORD: 'wrong-pass-1' } }));
                } catch (e) { lastError = e.name; }
            }
            let blocked = false;
            try {
                await cognito.send(new cog.InitiateAuthCommand({ ClientId: ctx.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: 'probe@okr18.test', PASSWORD: 'Probe-pass-123' } }));
            } catch (e) { blocked = true; lastError = e.name; }
            record('Cognito blocks repeated wrong passwords', blocked ? 'PASS' : 'INFO', blocked ? `then ${lastError}` : 'no lockout after 8 failures: rely on WAF rate rule and Turnstile');
        });
    }

    // 2. Lambda + IAM role
    const iam = new IAMClient(cfg);
    const lambda = new LambdaClient(cfg);
    await probe('Lambda create + invoke', async () => {
        const role = `probe-role-${RUN}`;
        await iam.send(new CreateRoleCommand({ RoleName: role, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }));
        cleanup.push(() => iam.send(new DeleteRoleCommand({ RoleName: role })));
        ctx.fn = `probe-echo-${RUN}`;
        await lambda.send(new CreateFunctionCommand({ FunctionName: ctx.fn, Runtime: 'nodejs22.x', Handler: 'index.handler', Role: `arn:aws:iam::${ACCOUNT}:role/${role}`, Code: { ZipFile: zipOne('index.js', ECHO) }, Timeout: 10 }));
        cleanup.push(() => lambda.send(new DeleteFunctionCommand({ FunctionName: ctx.fn })));
        await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: ctx.fn });
        const out = await lambda.send(new InvokeCommand({ FunctionName: ctx.fn, Payload: Buffer.from('{}') }));
        const body = JSON.parse(Buffer.from(out.Payload).toString());
        record('Lambda create + invoke', body.statusCode === 200 ? 'PASS' : 'FAIL', 'direct invoke, the way services call each other');
    });

    // 3. API Gateway HTTP API + JWT authorizer
    if (ctx.fn) {
        const api = new ApiGatewayV2Client(cfg);
        await probe('API Gateway route to Lambda', async () => {
            const created = await api.send(new gw.CreateApiCommand({ Name: `probe-api-${RUN}`, ProtocolType: 'HTTP' }));
            ctx.apiId = created.ApiId;
            cleanup.push(() => api.send(new gw.DeleteApiCommand({ ApiId: ctx.apiId })));
            const integ = await api.send(new gw.CreateIntegrationCommand({ ApiId: ctx.apiId, IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', IntegrationUri: `arn:aws:lambda:${region}:${ACCOUNT}:function:${ctx.fn}` }));
            await api.send(new gw.CreateRouteCommand({ ApiId: ctx.apiId, RouteKey: 'GET /open', Target: `integrations/${integ.IntegrationId}` }));
            if (ctx.issuer && ctx.clientId) {
                try {
                    const authz = await api.send(new gw.CreateAuthorizerCommand({
                        ApiId: ctx.apiId, Name: 'cognito', AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
                        JwtConfiguration: { Issuer: ctx.issuer, Audience: [ctx.clientId] }
                    }));
                    await api.send(new gw.CreateRouteCommand({ ApiId: ctx.apiId, RouteKey: 'GET /locked', Target: `integrations/${integ.IntegrationId}`, AuthorizationType: 'JWT', AuthorizerId: authz.AuthorizerId }));
                    ctx.authorizer = true;
                } catch (e) { record('JWT authorizer can be created', 'FAIL', e.name); }
            }
            await api.send(new gw.CreateStageCommand({ ApiId: ctx.apiId, StageName: '$default', AutoDeploy: true, DefaultRouteSettings: { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 } }));
            await lambda.send(new AddPermissionCommand({ FunctionName: ctx.fn, StatementId: 'apigw', Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceArn: `arn:aws:execute-api:${region}:${ACCOUNT}:${ctx.apiId}/*` }));
            const bases = [`http://${ctx.apiId}.execute-api.localhost.floci.io:4566`, `http://${ctx.apiId}.execute-api.localhost:4566`];
            for (const b of bases) {
                try { const r = await fetch(`${b}/open`); if (r.status === 200) { ctx.apiBase = b; break; } } catch { /* try next */ }
            }
            record('API Gateway route to Lambda', ctx.apiBase ? 'PASS' : 'FAIL', ctx.apiBase || 'no address answered');
        });

        if (ctx.apiBase) {
            await probe('API Gateway unknown route is refused', async () => {
                const r = await fetch(`${ctx.apiBase}/not-a-route`);
                record('API Gateway unknown route is refused', r.status === 404 ? 'PASS' : 'PARTIAL', `status ${r.status}`);
            });
        }
        if (ctx.apiBase && ctx.authorizer) {
            await probe('JWT authorizer enforced', async () => {
                const none = await fetch(`${ctx.apiBase}/locked`);
                const bad = await fetch(`${ctx.apiBase}/locked`, { headers: { authorization: 'Bearer abc.def.ghi' } });
                const good = await fetch(`${ctx.apiBase}/locked`, { headers: { authorization: `Bearer ${ctx.token}` } });
                const goodBody = good.status === 200 ? await good.json() : {};
                const enforced = none.status === 401 && bad.status === 401 && good.status === 200;
                record('JWT authorizer enforced', enforced ? 'PASS' : 'FAIL', `no token ${none.status}, bad ${bad.status}, good ${good.status}`);
                record('Claims passed to Lambda', goodBody.sub ? 'PASS' : 'FAIL', goodBody.sub ? 'sub arrives in requestContext' : 'verify the token inside each Lambda instead');
            });
        }
        if (ctx.apiBase) {
            await probe('API Gateway throttling', async () => {
                const codes = await Promise.all(Array.from({ length: 30 }, () => fetch(`${ctx.apiBase}/open`).then((r) => r.status).catch(() => 0)));
                const limited = codes.filter((c) => c === 429).length;
                record('API Gateway throttling', limited ? 'PASS' : 'INFO', limited ? `${limited} of 30 got 429` : 'setting accepted but not enforced: show it as configuration');
            });
        }
    }

    // 4. SNS -> SQS with a filter policy
    const sns = new SNSClient(cfg); const sqs = new SQSClient(cfg);
    await probe('SNS to SQS with event filter', async () => {
        const topic = await sns.send(new CreateTopicCommand({ Name: `probe-topic-${RUN}` }));
        cleanup.push(() => sns.send(new DeleteTopicCommand({ TopicArn: topic.TopicArn })));
        const q = await sqs.send(new CreateQueueCommand({ QueueName: `probe-queue-${RUN}` }));
        cleanup.push(() => sqs.send(new DeleteQueueCommand({ QueueUrl: q.QueueUrl })));
        const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: q.QueueUrl, AttributeNames: ['QueueArn'] }));
        await sns.send(new SubscribeCommand({ TopicArn: topic.TopicArn, Protocol: 'sqs', Endpoint: Attributes.QueueArn, Attributes: { FilterPolicy: JSON.stringify({ eventType: ['goal.deleted'] }), RawMessageDelivery: 'true' } }));
        for (const type of ['goal.deleted', 'goal.activated']) {
            await sns.send(new PublishCommand({ TopicArn: topic.TopicArn, Message: JSON.stringify({ type }), MessageAttributes: { eventType: { DataType: 'String', StringValue: type } } }));
        }
        await sleep(1500);
        const got = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
        const types = (got.Messages || []).map((m) => { const b = JSON.parse(m.Body); return b.type || JSON.parse(b.Message || '{}').type; });
        if (types.length === 1 && types[0] === 'goal.deleted') record('SNS to SQS with event filter', 'PASS', 'only goal.deleted arrived');
        else if (types.length) record('SNS to SQS with event filter', 'PARTIAL', `received ${JSON.stringify(types)}: filter in code as well`);
        else record('SNS to SQS with event filter', 'FAIL', 'nothing arrived');
    });

    // 5. EventBridge Scheduler
    if (ctx.fn) {
        const scheduler = new SchedulerClient(cfg);
        await probe('EventBridge Scheduler', async () => {
            const name = `probe-schedule-${RUN}`;
            await scheduler.send(new CreateScheduleCommand({
                Name: name, ScheduleExpression: 'cron(0 6 * * ? *)', ScheduleExpressionTimezone: 'Africa/Cairo', FlexibleTimeWindow: { Mode: 'OFF' },
                Target: { Arn: `arn:aws:lambda:${region}:${ACCOUNT}:function:${ctx.fn}`, RoleArn: `arn:aws:iam::${ACCOUNT}:role/probe-role-${RUN}` }
            }));
            cleanup.push(() => scheduler.send(new DeleteScheduleCommand({ Name: name })));
            record('EventBridge Scheduler', 'PASS', 'schedule accepted; whether it fires is shown by its log line');
        });
    }

    // 6. SES
    const ses = new SESv2Client(cfg);
    await probe('SES send email', async () => {
        await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: 'noreply@okr18.test' }));
        cleanup.push(() => ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: 'noreply@okr18.test' })));
        const out = await ses.send(new SendEmailCommand({
            FromEmailAddress: 'noreply@okr18.test', Destination: { ToAddresses: ['student@okr18.test'] },
            Content: { Simple: { Subject: { Data: 'OKR18 probe' }, Body: { Text: { Data: 'Weekly digest test' } } } }
        }));
        record('SES send email', out.MessageId ? 'PASS' : 'FAIL', 'Floci keeps the message instead of sending it');
    });

    // 7. S3 signed upload with size and type limits
    const s3 = new S3Client({ ...cfg, forcePathStyle: true });
    await probe('S3 signed upload limits', async () => {
        const Bucket = `probe-evidence-${RUN}`;
        await s3.send(new CreateBucketCommand({ Bucket }));
        cleanup.push(async () => {
            const list = await s3.send(new ListObjectsV2Command({ Bucket }));
            for (const o of list.Contents || []) await s3.send(new DeleteObjectCommand({ Bucket, Key: o.Key }));
            await s3.send(new DeleteBucketCommand({ Bucket }));
        });
        const post = await createPresignedPost(s3, {
            Bucket, Key: 'u1/c1.png', Expires: 300,
            Conditions: [['content-length-range', 1, 2 * 1024 * 1024], ['eq', '$Content-Type', 'image/png']],
            Fields: { 'Content-Type': 'image/png' }
        });
        const send = async (bytes, type) => {
            const form = new FormData();
            Object.entries({ ...post.fields, 'Content-Type': type }).forEach(([k, v]) => form.append(k, v));
            form.append('file', new Blob([Buffer.alloc(bytes)]), 'f');
            return (await fetch(post.url, { method: 'POST', body: form })).status;
        };
        const small = await send(1000, 'image/png');
        const big = await send(3 * 1024 * 1024, 'image/png');
        const wrongType = await send(1000, 'application/x-msdownload');
        const ok = small < 300 && big >= 400 && wrongType >= 400;
        record('S3 signed upload limits', ok ? 'PASS' : small < 300 ? 'PARTIAL' : 'FAIL', `small ${small}, 3 MB ${big}, .exe type ${wrongType}`);
    });

    // 8. WAF v2
    const waf = new WAFV2Client(cfg);
    await probe('WAF v2 web ACL with rate rule', async () => {
        const name = `probe-acl-${RUN}`;
        const out = await waf.send(new CreateWebACLCommand({
            Name: name, Scope: 'CLOUDFRONT', DefaultAction: { Allow: {} },
            VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'probe' },
            Rules: [{ Name: 'login-rate', Priority: 1, Action: { Block: {} },
                Statement: { RateBasedStatement: { Limit: 100, AggregateKeyType: 'IP' } },
                VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'login-rate' } }]
        }));
        cleanup.push(() => waf.send(new DeleteWebACLCommand({ Name: name, Scope: 'CLOUDFRONT', Id: out.Summary.Id, LockToken: out.Summary.LockToken })));
        record('WAF v2 web ACL with rate rule', 'PASS', 'created; blocking is shown as configuration unless traffic is filtered');
    });

    // 9. Secrets Manager
    const sm = new SecretsManagerClient(cfg);
    await probe('Secrets Manager', async () => {
        const name = `probe/secret-${RUN}`;
        await sm.send(new CreateSecretCommand({ Name: name, SecretString: 'not-a-real-secret' }));
        cleanup.push(() => sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })));
        const got = await sm.send(new GetSecretValueCommand({ SecretId: name }));
        record('Secrets Manager', got.SecretString === 'not-a-real-secret' ? 'PASS' : 'FAIL');
    });

    console.log('\nCleaning up probe resources...');
    for (const undo of cleanup.reverse()) { try { await undo(); } catch { /* already gone */ } }

    const count = (s) => results.filter((r) => r.status === s).length;
    console.log(`\nSummary: ${count('PASS')} PASS, ${count('PARTIAL')} PARTIAL, ${count('FAIL')} FAIL, ${count('INFO')} INFO`);
    console.log('Copy this whole output into the team group. FAIL or PARTIAL items use the fallback in the design doc.');
}

main().catch((e) => { console.error('Stopped:', e.name, e.message); console.error('Is Floci running? docker compose -f ../floci/docker-compose.yml up -d'); process.exit(1); });
