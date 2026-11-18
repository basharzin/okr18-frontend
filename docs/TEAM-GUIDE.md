# Team 18 guide: how to build your service so it joins the app

Everything in the shared platform and the Goals Service already runs on Floci:
sign-up and login (Cognito + Turnstile + account lockout), API Gateway `okr18-api`,
the event topic `okr-events`, and Goals (rules G1–G8).
This page is what Key Results and Check-ins need to plug in. The rules of each service
are in the design doc; this page is the **names and shapes** that must match exactly.

| Repo | Owner |
| --- | --- |
| [okr18-frontend](https://github.com/basharzin/okr18-frontend) | Bashar Zain |
| [okr18-goals-service](https://github.com/basharzin/okr18-goals-service) | Bashar Zain |
| okr18-keyresults-service (your own GitHub account) | Amr Shalaby |
| okr18-checkins-service (your own GitHub account) | Amr Hosni |

## 1. Set up once (Git Bash, Docker Desktop running)

You need what the Lab 7 Installation Guide installs: Docker Desktop, Git Bash, AWS CLI and the `floci` profile.

```
mkdir team18 && cd team18
git clone https://github.com/basharzin/okr18-frontend.git
git clone https://github.com/basharzin/okr18-goals-service.git
# put YOUR repo here too, next to these two

cd okr18-frontend
docker compose -f infra/floci/docker-compose.yml up -d
cd infra/tools && npm install && node check-floci.js && cd ../..
bash infra/deploy-all.sh
```

`deploy-all.sh` creates Cognito, the API, the topic and the secret on YOUR Floci, deploys login
and Goals, and deploys your service too if it finds `../okr18-<yours>/scripts/deploy.sh`.
Then `npx serve public -l 8080` and open http://localhost:8080.

Your ids (API id, pool id, topic ARN) are in `okr18-frontend/infra/okr18-vars.sh` after the setup.
Your deploy script reads them: `source ../okr18-frontend/infra/okr18-vars.sh`.

## 2. How separate repos become one app

No service imports another service's code. They all run on the same Floci and meet only through:

- **routes** on the same API Gateway `okr18-api` (each service adds its own routes);
- **Lambda names** for direct calls (`goals-internal`, `kr-internal`);
- **event types** on the SNS topic `okr-events`.

So the names and the request/response shapes below must match exactly.
For the demo, one PC clones all four repos side by side and runs `bash infra/deploy-all.sh` once.

## 3. Build it the same way as okr18-goals-service

Take the structure, write your own code and rules:

| File | What it is |
| --- | --- |
| `src/rules.js` + `test/rules.test.js` | your business rules as pure functions, with tests (`npm test`) |
| `src/<name>Repo.js` | the only file that talks to your DynamoDB table |
| `src/createApp.js`, `app.js`, `handlers/api.js` | Express app; Lambda handler via `serverless-http@4` (v3 loses POST bodies) |
| `src/auth.js` | **copy it unchanged from Goals**: Floci's gateway authorizer rejects valid tokens, so every Lambda checks the Cognito token itself |
| `scripts/deploy.sh`, `scripts/zip-lambda.js` | create/update table, role, Lambdas, routes. Copy the `write_env` and `add_route` helpers: env vars go as a JSON file because `CORS_ORIGINS` contains a comma |
| `infra/iam/*.json` | least privilege: your table, your queue, only the functions you call |
| `events/` | saved Lambda events to test without the website |

Every route needs an `OPTIONS` route next to it (the browser's CORS preflight), like Goals' deploy script.
Error shape: `{ "error": { "code": "SOME_CODE", "message": "Human sentence." } }`.
Another user's record answers **404**, never 403 or the record.

## 4. Amr Shalaby: Key Results Service

**Lambdas:** `kr-api` (routes), `kr-internal` (direct invoke only), `kr-events` (reads the queue).
**Table:** `KeyResults` (key `krId`, index on `goalId`). **Role:** `kr-role`.

**`kr-internal` must answer exactly this** (Goals and Check-ins call it):

| Request | Answer |
| --- | --- |
| `{"action":"countKeyResults","goalId":"G-..."}` | `{"count": 2}` |
| `{"action":"getGoalsProgress","goalIds":["G-...","G-..."]}` | `{"progress": {"G-...": 62.5}}` weighted 0–100; unknown goal = 0 |
| `{"action":"getKeyResult","krId":"..."}` | `{"found": true, "userId", "goalId", "type", "start", "target", "current", "status"}` or `{"found": false}` |

**You call** `goals-internal` with `{"action":"getGoalStatus","goalId":"G-..."}` → `{"found", "userId", "status", "year"}`
before any write (rule K4): wrong owner → 404; goal not Draft/Active → 409.

**Events:** queue `kr-inbox` (+ dead-letter queue after 3 tries) subscribed to `okr-events` with
filter `{"eventType": ["check-in.logged", "check-in.undone", "goal.deleted", "goal.abandoned", "goal.reopened"]}`.
You publish `kr.completed`. Envelope: `{ "type", "userId", "at", "data" }` with message attribute `eventType`.

**Routes:** `POST|GET /api/goals/{goalId}/key-results`, `GET|PATCH|DELETE /api/key-results/{id}`, plus `OPTIONS` for each path.

**IAM `kr-role`:** your table + index, your queue, `sns:Publish` on `okr-events`, `lambda:InvokeFunction` on `goals-internal`, your logs.

**Frontend:** the key-results panel inside `goal.html` (element `#key-results-panel`), in `public/js/key-results.js`.
Shared layout task: build on `public/js/api.js` and `public/js/ui.js`.

**Security tests:** ST6 (injection), ST10 (role cannot read another table), ST9 (secret scan of all repos before submission).

Until `kr-internal` exists, Activate and Achieve in Goals answer 503 on purpose.

## 5. Amr Hosni: Check-ins & Insights Service

**Lambdas:** `checkins-api`, `weekly-digest`, `checkins-events`, `admin-api`.
**Tables:** `CheckIns` (key `checkInId`, indexes `krId`+`createdAt` and `userId`+`createdAt`), `UserPrefs` (key `userId`). **Role:** `checkins-role`.

**Before logging a check-in (rule C1):**
1. invoke `kr-internal` `{"action":"getKeyResult","krId"}`: not found or wrong owner → 404;
2. invoke `goals-internal` `{"action":"getGoalStatus","goalId"}`: goal must be `Active` or `AtRisk`, else 409.

**You publish** `check-in.logged` with `data: {krId, value, previousValue}` and
`check-in.undone` with `data: {krId, previousValue}`. Key Results reads both to change `current`.
**Queue** `checkins-inbox` subscribed with filter `{"eventType": ["goal.at_risk", "goal.back_on_track", "goal.achieved", "kr.completed"]}`.

**Evidence uploads:** private S3 bucket, presigned POST, max 2 MB, image or PDF only (check-floci: PASS).
**Weekly digest:** SES from `noreply@okr18.test`, EventBridge Scheduler Mondays 08:00 `Africa/Cairo` (Floci keeps the email instead of sending it).

**Admin (shared task):** `admin-api` checks `admin` in the token's `cognito:groups`, else 403.
`GET /api/admin/users`, `POST /api/admin/users/{id}/disable|enable` (Cognito AdminDisableUser/AdminEnableUser),
`GET /api/admin/security-events` (CloudWatch Logs query for lines with `"security"`: the auth service writes
`login_failed`, `login_locked`, `bot_check_failed`; Goals writes `auth_failed`).

**IAM `checkins-role`:** your tables, your bucket, `ses:SendEmail` from your identity only, `sns:Publish`, your queue,
invoke `kr-internal` and `goals-internal`, your logs. `admin-api` gets its own role with only the Cognito admin actions and log reads.

**Frontend:** check-in form and history, weekly banner, stalled page, admin pages.
**Security tests:** ST4 (role), ST7 (stored XSS), ST11 (upload limits), ST12 (failures visible on the admin page). Report lead.

## 6. Making yourself admin (for testing)

```
source infra/okr18-vars.sh
aws cognito-idp admin-add-user-to-group --user-pool-id $COGNITO_USER_POOL_ID --username you@okr18.test --group-name admin
```
Log in again afterwards: the group is read from the new token.
