# okr18-frontend

Team 18 OKR Tracker: the website and the shared platform every service uses.

| Folder | What | Owner |
| --- | --- | --- |
| `infra/floci/` | Floci (local AWS) for the whole team | Bashar |
| `infra/tools/check-floci.js` | Task 5: which AWS features Floci supports (PASS / PARTIAL / FAIL) | Bashar |
| `infra/tools/security-tests.js` | Security tests ST1, ST2, ST3, ST5, ST8 against the running app (`npm run security`) | Bashar |
| `infra/tools/evidence.js` | Report evidence: security events in CloudWatch Logs, no secrets in logs, GoalsAtRisk metric, IAM least privilege (`npm run evidence`) | Bashar |
| `infra/shared-setup.sh` | Cognito pool and groups, SNS topic `okr-events`, Turnstile secret in Secrets Manager, API Gateway `okr18-api` with throttling (each Lambda checks the Cognito token itself, because Floci's JWT authorizer rejects valid tokens) | Bashar |
| `platform/auth-service/` | Sign-up, login, logout, me (Cognito + Turnstile) | Bashar |
| `public/` | Pages. Login and Goals pages done (Bashar); layout, nav and `api.js` are the shared layout task (Amr Shalaby); Key Results and Check-ins pages by their owners | all |

## Run the whole app (examiners)

Needs Docker Desktop (running), Node.js 22, AWS CLI v2 and Git Bash on Windows (any bash on Linux or macOS).

1. Point the AWS CLI at Floci once. Floci accepts any keys; these are placeholders, not real credentials:

```
aws configure set aws_access_key_id test --profile floci
aws configure set aws_secret_access_key test --profile floci
aws configure set region us-east-1 --profile floci
aws configure set endpoint_url http://localhost:4566 --profile floci
```

2. Clone the four repos side by side in one folder, start Floci and deploy everything:

```
mkdir team18 && cd team18
git clone https://github.com/basharzin/okr18-frontend.git
git clone https://github.com/basharzin/okr18-goals-service.git
git clone https://github.com/amr223481/okr18-keyresults-service.git
git clone https://github.com/Ol4F-Aj/okr18-checkins-service.git
cd okr18-frontend
docker compose -f infra/floci/docker-compose.yml up -d
sleep 10
aws sts get-caller-identity --profile floci        # Account 000000000000 means Floci answers
bash infra/deploy-all.sh
```

The first run asks for the Turnstile secret key: press Enter to use Cloudflare's public test key
(it always passes, fine for Floci). Nothing else needs to be typed.

3. Open the website: http://localhost:4566/okr18-web/index.html and sign up.

4. To try the admin page, add your account to the `admin` group (the pool id is in `infra/okr18-vars.sh`):

```
source infra/okr18-vars.sh
aws cognito-idp admin-add-user-to-group --profile floci --user-pool-id "$COGNITO_USER_POOL_ID" --username you@example.com --group-name admin
```

Then log out and in again so the new token carries the group.

5. Optional end-to-end and security checks: `bash scripts/e2e.sh` in okr18-checkins-service, and
`npm install && npm run security && npm run evidence` in `infra/tools` (see below).

## Configuration and environment variables

No `.env` file is needed to run the app on Floci: `deploy-all.sh` creates Cognito, the API, the topic and the
secret, writes their ids to `infra/okr18-vars.sh`, and each deploy script passes them to its Lambdas as
environment variables. `infra/write-config.sh` writes the website's `public/js/config.js` (API address and the
public Turnstile site key).

To run one service on a PC with `npm run dev`, copy that repo's `.env.example` to `.env` and fill the empty
values from `infra/okr18-vars.sh`. Every `.env.example` holds names and placeholders only, never secrets:

| File | Main variables |
| --- | --- |
| `platform/auth-service/.env.example` | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_ISSUER`, `COGNITO_JWKS_URI`, `TURNSTILE_SECRET_ARN`, `LOGIN_ATTEMPTS_TABLE` |
| `okr18-goals-service/.env.example` | `GOALS_TABLE`, `KR_INTERNAL_FUNCTION`, `EVENTS_TOPIC_ARN`, `COGNITO_ISSUER`, `COGNITO_JWKS_URI`, `COGNITO_CLIENT_ID` |
| `okr18-keyresults-service/.env.example` | `KR_TABLE`, `GOALS_INTERNAL_FUNCTION`, `EVENTS_TOPIC_ARN`, `COGNITO_ISSUER`, `COGNITO_JWKS_URI`, `COGNITO_CLIENT_ID` |
| `okr18-checkins-service/.env.example` | `CHECKINS_TABLE`, `KR_INTERNAL_FUNCTION`, `GOALS_INTERNAL_FUNCTION`, `EVENTS_TOPIC_ARN`, `COGNITO_*`, `COGNITO_USER_POOL_ID` |
| `public/js/config.example.js` | `apiUrl`, `turnstileSiteKey` (public) |

All of them also take `AWS_PROFILE=floci`, `AWS_REGION=us-east-1`, `AWS_ENDPOINT_URL=http://localhost:4566`,
`ALLOW_HTTP_JWKS=true` (Floci only), `CORS_ORIGINS` and `RATE_LIMIT_MAX`.

## The four repositories

| Repo | Owner |
| --- | --- |
| [okr18-frontend](https://github.com/basharzin/okr18-frontend) | Bashar Zain |
| [okr18-goals-service](https://github.com/basharzin/okr18-goals-service) | Bashar Zain |
| [okr18-keyresults-service](https://github.com/amr223481/okr18-keyresults-service) | Amr Shalaby |
| [okr18-checkins-service](https://github.com/Ol4F-Aj/okr18-checkins-service) | Amr Hosni |

They are separate repos but ONE app at run time: every service is deployed into the same Floci
(same Cognito, same API Gateway `okr18-api`, same SNS topic `okr-events`). Services never import each
other's code; they meet only through the names in the API contracts (routes, Lambda function names,
event types). To run everything on one PC, clone the four repos side by side and run:

```
bash infra/deploy-all.sh
```

## Secrets

The only secret is the Turnstile secret key. `shared-setup.sh` asks for it once (hidden input) and stores it in
Secrets Manager; the auth Lambda reads it with its own IAM permission. `infra/okr18-vars.sh` holds ids and
addresses only and is still kept out of Git. The site key (public) goes in the frontend config.

For Floci, pressing Enter uses Cloudflare's published test secret that always passes. Never use it on a real site.

## Security tests and evidence (for the report)

After `bash infra/deploy-all.sh`, with Floci running:

```
cd infra/tools
npm install
npm run security     # ST1, ST2, ST3, ST5, ST8, security headers, rate limit: Expected / Actual / PASS
npm run evidence     # CloudWatch security events, no secrets in logs, GoalsAtRisk metric, IAM least privilege
```

Both make their own test users and delete them at the end. `npm run security` ends by using up
your IP's rate limit (60 requests a minute), so wait a minute before using the website again.
The website's own security headers (CSP and others) are in `public/serve.json`; run `npx serve public -l 8080` before the tests to check them too. INFO lines are things Floci does not
enforce (API throttling, and Turnstile when Cloudflare's test secret is used); the report shows them as configuration.
