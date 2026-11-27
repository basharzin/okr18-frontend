#!/usr/bin/env bash
# ---------------------------------------------------------------
# Shared base for all three services (lead: Bashar). Run once on each PC:
#   bash infra/shared-setup.sh
# Creates (or finds) on Floci:
#   - Cognito user pool okr18-users, app client okr18-web, groups user + admin
#   - SNS topic okr-events (all service events)
#   - Secrets Manager secret okr18/turnstile-secret (the Turnstile secret key)
#   - API Gateway HTTP API okr18-api: JWT authorizer + throttling
# Writes the ids (never secrets) to infra/okr18-vars.sh for the service scripts.
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
VARS=infra/okr18-vars.sh
none() { [ -z "$1" ] || [ "$1" = "None" ]; }

echo "1/5 Cognito user pool, app client, groups"
POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='okr18-users'].Id | [0]" --output text)
if none "$POOL_ID"; then
  POOL_ID=$(aws cognito-idp create-user-pool --pool-name okr18-users \
    --policies "PasswordPolicy={MinimumLength=10,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}" \
    --username-attributes email --auto-verified-attributes email \
    --query UserPool.Id --output text)
fi
CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --query "UserPoolClients[?ClientName=='okr18-web'].ClientId | [0]" --output text)
if none "$CLIENT_ID"; then
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name okr18-web \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --access-token-validity 15 --id-token-validity 15 --refresh-token-validity 1 \
    --token-validity-units "AccessToken=minutes,IdToken=minutes,RefreshToken=days" \
    --query UserPoolClient.ClientId --output text)
fi
for G in user admin; do
  aws cognito-idp get-group --user-pool-id "$POOL_ID" --group-name $G > /dev/null 2>&1 || \
    aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name $G > /dev/null
done

# Find the token issuer the way Floci really writes it: log a throw-away user in and read "iss"
SETUP_USER="setup-check@okr18.test"
SETUP_PASS="Setup-check-$(date +%s)Aa1"
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$SETUP_USER" --message-action SUPPRESS > /dev/null 2>&1 || true
aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$SETUP_USER" --password "$SETUP_PASS" --permanent > /dev/null
TOKEN=$(aws cognito-idp initiate-auth --client-id "$CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$SETUP_USER,PASSWORD=$SETUP_PASS" --query AuthenticationResult.AccessToken --output text)
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "$SETUP_USER" > /dev/null
ISSUER=$(node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url')).iss)" "$TOKEN")
JWKS_URI="${ISSUER%/}/.well-known/jwks.json"
# Lambdas run in their own containers, where Floci is called "floci"; a PC reaches it as "localhost"
JWKS_URI_FOR_LAMBDA=$(echo "$JWKS_URI" | sed 's#//localhost:4566#//floci:4566#; s#//127.0.0.1:4566#//floci:4566#')
JWKS_URI=$(echo "$JWKS_URI" | sed 's#//floci:4566#//localhost:4566#')
echo "   pool $POOL_ID, client $CLIENT_ID, issuer $ISSUER"

echo "2/5 SNS topic okr-events"
TOPIC_ARN=$(aws sns create-topic --name okr-events --query TopicArn --output text)   # returns the existing one if present

echo "3/5 Secrets Manager: okr18/turnstile-secret"
if ! aws secretsmanager describe-secret --secret-id okr18/turnstile-secret > /dev/null 2>&1; then
  echo "   Paste the Turnstile SECRET key (input hidden). Press Enter to use Cloudflare's"
  echo "   public test key that always passes (fine for Floci, never for a real site)."
  read -r -s TS_SECRET; echo
  TS_SECRET="${TS_SECRET:-1x0000000000000000000000000000000AA}"
  aws secretsmanager create-secret --name okr18/turnstile-secret --secret-string "$TS_SECRET" > /dev/null
  unset TS_SECRET
fi
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id okr18/turnstile-secret --query ARN --output text)

echo "4/5 API Gateway okr18-api (JWT authorizer, throttling 10 req/s, burst 20)"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='okr18-api'].ApiId | [0]" --output text)
if none "$API_ID"; then
  API_ID=$(aws apigatewayv2 create-api --name okr18-api --protocol-type HTTP --query ApiId --output text)
fi
# check-floci.js showed Floci's JWT authorizer rejects valid tokens too, so on Floci every Lambda checks
# the Cognito token itself (src/auth.js). On real AWS run with USE_JWT_AUTHORIZER=true to add the gateway check as well.
AUTHORIZER_ID=""
if [ "${USE_JWT_AUTHORIZER:-false}" = true ]; then
  AUTHORIZER_ID=$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --query "Items[?Name=='cognito'].AuthorizerId | [0]" --output text)
  if none "$AUTHORIZER_ID"; then
    AUTHORIZER_ID=$(aws apigatewayv2 create-authorizer --api-id "$API_ID" --name cognito --authorizer-type JWT \
      --identity-source '$request.header.Authorization' \
      --jwt-configuration "Audience=$CLIENT_ID,Issuer=$ISSUER" --query AuthorizerId --output text)
  fi
else
  echo "   No gateway JWT authorizer on Floci: each Lambda checks the token (see check-floci results)."
fi
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
  --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=10 > /dev/null 2>&1 || \
  aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
  --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=10 > /dev/null 2>&1 || true
API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"

echo "5/5 Writing $VARS (ids only, safe to share inside the team)"
cat > "$VARS" <<EOF
# Written by infra/shared-setup.sh on $(date -u +%Y-%m-%dT%H:%MZ). Ids and addresses only: no secrets.
export AWS_REGION=$REGION
export ACCOUNT_ID=$ACCOUNT
export COGNITO_USER_POOL_ID=$POOL_ID
export COGNITO_CLIENT_ID=$CLIENT_ID
export COGNITO_ISSUER=$ISSUER
export COGNITO_JWKS_URI=$JWKS_URI_FOR_LAMBDA
export COGNITO_JWKS_URI_LOCAL=$JWKS_URI
export EVENTS_TOPIC_ARN=$TOPIC_ARN
export TURNSTILE_SECRET_ARN=$SECRET_ARN
export API_ID=$API_ID
export AUTHORIZER_ID=${AUTHORIZER_ID:-}
export API_URL=$API_URL
export CORS_ORIGINS=http://localhost:8080,http://localhost:4566
EOF
cat "$VARS"
echo "Done. Each service repo reads $VARS when it deploys."
