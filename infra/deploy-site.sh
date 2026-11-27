#!/usr/bin/env bash
# ---------------------------------------------------------------
# Put the website on S3 (Floci), as in the Lab 7 "API Gateway and S3" lab:
# the browser loads the pages from the bucket and calls okr18-api.
# Run from okr18-frontend in Git Bash, after the services are deployed:
#   bash infra/deploy-site.sh
# Safe to run again: it uploads only what changed and removes deleted pages.
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUCKET="${SITE_BUCKET:-okr18-web}"

echo "1/3 Bucket $BUCKET (only website files go in it: everyone can read them)"
aws s3api head-bucket --bucket "$BUCKET" > /dev/null 2>&1 || aws s3 mb "s3://$BUCKET" > /dev/null

echo "2/3 Website config (API address and the public Turnstile site key, nothing secret)"
[ -f public/js/config.js ] || bash infra/write-config.sh

echo "3/3 Upload pages, styles and scripts with the right content types"
# serve.json (local server settings) and config.example.js are not part of the website
aws s3 sync public "s3://$BUCKET" --delete --exclude "*" --include "*.html" \
  --content-type "text/html; charset=utf-8" > /dev/null
aws s3 sync public/css "s3://$BUCKET/css" --delete --exclude "*" --include "*.css" \
  --content-type "text/css; charset=utf-8" > /dev/null
aws s3 sync public/js "s3://$BUCKET/js" --delete --exclude "*" --include "*.js" --exclude "config.example.js" \
  --content-type "text/javascript; charset=utf-8" > /dev/null
aws s3 ls "s3://$BUCKET" --recursive | awk '{print "   " $4}'

URL="http://localhost:4566/$BUCKET/index.html"
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" || true)
echo "Website: $URL  (answers $code)"
