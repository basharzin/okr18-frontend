# okr18-frontend

Team 18 OKR Tracker: the website and the shared platform every service uses.

| Folder | What | Owner |
| --- | --- | --- |
| `infra/floci/` | Floci (local AWS) for the whole team | Bashar |
| `infra/tools/check-floci.js` | Task 5: which AWS features Floci supports (PASS / PARTIAL / FAIL) | Bashar |
| `infra/shared-setup.sh` | Cognito pool and groups, SNS topic `okr-events`, Turnstile secret in Secrets Manager, API Gateway `okr18-api` with JWT authorizer and throttling | Bashar |
| `platform/auth-service/` | Sign-up, login, logout, me (Cognito + Turnstile) | Bashar |
| `public/` | Pages. Login and Goals pages done (Bashar); layout, nav and `api.js` are the shared layout task (Amr Shalaby); Key Results and Check-ins pages by their owners | all |

## First time on a PC (Git Bash, Docker Desktop running)

```
docker compose -f infra/floci/docker-compose.yml up -d
aws sts get-caller-identity --query Account --output text        # 000000000000

cd infra/tools && npm install && node check-floci.js && cd ../..  # Task 5: paste the output in the group
bash infra/shared-setup.sh                                        # writes infra/okr18-vars.sh (ids only)
cd platform/auth-service && npm install && npm test && bash scripts/deploy.sh && cd ../..
```

## Run the website on your PC

```
bash infra/write-config.sh          # writes public/js/config.js with your API address
npx serve public -l 8080           # then open http://localhost:8080
```

Then each service repo deploys itself (`bash scripts/deploy.sh`), reading `../okr18-frontend/infra/okr18-vars.sh`.
Keep the four repos side by side in one folder so that path works.

## Secrets

The only secret is the Turnstile secret key. `shared-setup.sh` asks for it once (hidden input) and stores it in
Secrets Manager; the auth Lambda reads it with its own IAM permission. `infra/okr18-vars.sh` holds ids and
addresses only and is still kept out of Git. The site key (public) goes in the frontend config.

For Floci, pressing Enter uses Cloudflare's published test secret that always passes. Never use it on a real site.
