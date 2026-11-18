#!/usr/bin/env bash
# ---------------------------------------------------------------
# Deploy the shared auth service (auth-api Lambda + its 4 routes).
# Run after infra/shared-setup.sh, from platform/auth-service in Git Bash:
#   bash scripts/deploy.sh
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
# shellcheck source=/dev/null
source "${SHARED_VARS:-../../infra/okr18-vars.sh}"
ROLE=auth-role
FN=auth-api
mkdir -p out

echo "0/4 DynamoDB table LoginAttempts (account lockout, rows expire by TTL)"
if ! aws dynamodb describe-table --table-name LoginAttempts > /dev/null 2>&1; then
  aws dynamodb create-table --table-name LoginAttempts \
    --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST --sse-specification Enabled=true,SSEType=KMS > /dev/null
  aws dynamodb wait table-exists --table-name LoginAttempts
  aws dynamodb update-time-to-live --table-name LoginAttempts \
    --time-to-live-specification Enabled=true,AttributeName=ttl > /dev/null 2>&1 || true
fi

echo "1/4 IAM: $ROLE (confirm and group users in our pool, read the Turnstile secret, its lockout table, own logs)"
aws iam get-role --role-name $ROLE > /dev/null 2>&1 || \
  aws iam create-role --role-name $ROLE --assume-role-policy-document file://infra/iam/trust-policy.json > /dev/null
sed "s#POOL_ID#$COGNITO_USER_POOL_ID#; s#SECRET_ARN#$TURNSTILE_SECRET_ARN#; s/000000000000/$ACCOUNT/g; s/us-east-1/$REGION/g" \
  infra/iam/auth-policy.json > out/auth-policy.json
aws iam put-role-policy --role-name $ROLE --policy-name auth-access --policy-document file://out/auth-policy.json

echo "2/4 Install and zip"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run zip --silent

echo "3/4 Lambda $FN"
# Lambda environment variables as a JSON file: the CLI's short form breaks on values that
# contain commas (CORS_ORIGINS has two addresses), JSON does not.
write_env() {   # KEY=VALUE ...  ->  out/env.json
  node -e 'const v={};for(const kv of process.argv.slice(1)){const i=kv.indexOf("=");v[kv.slice(0,i)]=kv.slice(i+1);}require("fs").writeFileSync("out/env.json",JSON.stringify({Variables:v}));' "$@"
}
write_env NODE_ENV=production "COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID" "COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID" \
  "COGNITO_ISSUER=$COGNITO_ISSUER" "COGNITO_JWKS_URI=$COGNITO_JWKS_URI" "ALLOW_HTTP_JWKS=${ALLOW_HTTP_JWKS:-true}" \
  "TURNSTILE_SECRET_ARN=$TURNSTILE_SECRET_ARN" LOGIN_ATTEMPTS_TABLE=LoginAttempts "CORS_ORIGINS=$CORS_ORIGINS"
if aws lambda get-function --function-name $FN > /dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --zip-file fileb://lambda.zip > /dev/null
  aws lambda wait function-updated-v2 --function-name $FN
  aws lambda update-function-configuration --function-name $FN --environment file://out/env.json > /dev/null
else
  aws lambda create-function --function-name $FN --runtime nodejs24.x --handler handlers/api.handler \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file fileb://lambda.zip --timeout 10 --memory-size 128 \
    --environment file://out/env.json > /dev/null
fi
aws lambda wait function-active-v2 --function-name $FN
aws logs create-log-group --log-group-name "/aws/lambda/$FN" > /dev/null 2>&1 || true
aws logs put-retention-policy --log-group-name "/aws/lambda/$FN" --retention-in-days 7 > /dev/null 2>&1 || true

echo "4/4 Routes on okr18-api"
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --payload-format-version 2.0 --integration-uri "$FN_ARN" --query IntegrationId --output text)
fi
EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
add_route() {
  if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -Fxq "$1"; then return; fi
  if [ "$2" = yes ] && [ -n "${AUTHORIZER_ID:-}" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
      --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteKey --output text
  else
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" --query RouteKey --output text
  fi
}
add_route "POST /api/auth/signup" no     # protected by Turnstile + WAF rate rule, not by a token
add_route "POST /api/auth/login" no
add_route "POST /api/auth/logout" yes
add_route "GET /api/auth/me" yes
# CORS preflight for the browser (Express cors() answers it)
add_route "OPTIONS /api/auth/signup" no
add_route "OPTIONS /api/auth/login" no
add_route "OPTIONS /api/auth/logout" no
add_route "OPTIONS /api/auth/me" no
aws lambda add-permission --function-name $FN --statement-id apigw-invoke-auth --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null 2>&1 || true

echo "Done. Try: curl -s -X POST $API_URL/api/auth/login -H 'content-type: application/json' -d '{}'"
