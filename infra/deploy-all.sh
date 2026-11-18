#!/usr/bin/env bash
# ---------------------------------------------------------------
# Deploy the WHOLE app onto one Floci (for the demo, or to test integration).
# The four repos must sit side by side in one folder:
#
#   team18/
#     okr18-frontend/              (this repo)
#     okr18-goals-service/
#     okr18-keyresults-service/
#     okr18-checkins-service/
#
# Run from okr18-frontend in Git Bash:   bash infra/deploy-all.sh
# A service repo that is missing is skipped, so it also works mid-project.
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$ROOT")"

echo "== Floci"
aws sts get-caller-identity --query Account --output text > /dev/null || {
  echo "Floci is not answering. Start Docker Desktop, then: docker compose -f infra/floci/docker-compose.yml up -d"; exit 1; }

echo "== Shared base (Cognito, SNS topic, secret, API Gateway)"
if [ ! -f "$ROOT/infra/okr18-vars.sh" ]; then (cd "$ROOT" && bash infra/shared-setup.sh); else echo "already set up: infra/okr18-vars.sh"; fi

echo "== Auth service"
(cd "$ROOT/platform/auth-service" && npm install --no-audit --no-fund --loglevel=error && bash scripts/deploy.sh)

# Order matters only for the first run: Goals and Key Results call each other,
# but each Lambda finds the other by name when a request arrives, not at deploy time.
for repo in okr18-goals-service okr18-keyresults-service okr18-checkins-service; do
  echo "== $repo"
  if [ -f "$PARENT/$repo/scripts/deploy.sh" ]; then
    (cd "$PARENT/$repo" && npm install --no-audit --no-fund --loglevel=error && bash scripts/deploy.sh)
  else
    echo "   not found next to okr18-frontend: skipped"
  fi
done

echo "== Website config"
(cd "$ROOT" && bash infra/write-config.sh)
echo "Done. Serve the site:  npx serve public -l 8080   then open http://localhost:8080"
