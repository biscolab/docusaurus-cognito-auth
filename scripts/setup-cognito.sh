#!/usr/bin/env bash
# Optional: manually create a Cognito User Pool via AWS CLI.
# You can skip this if you use the SAM template — it creates the pool automatically.
# Useful for pre-provisioning or debugging.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_NAME="${COGNITO_POOL_NAME:-docusaurus-auth-pool}"
DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-}"
CALLBACK_URL="${CALLBACK_URL:-}"

if [[ -z "$DOMAIN_PREFIX" || -z "$CALLBACK_URL" ]]; then
  echo "Usage: COGNITO_DOMAIN_PREFIX=my-prefix CALLBACK_URL=https://xxx.cloudfront.net/callback bash scripts/setup-cognito.sh"
  exit 1
fi

echo "==> Creating Cognito User Pool: $POOL_NAME in $REGION"
POOL_ID=$(aws cognito-idp create-user-pool \
  --pool-name "$POOL_NAME" \
  --region "$REGION" \
  --auto-verified-attributes email \
  --username-attributes email \
  --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
  --query 'UserPool.Id' \
  --output text)

echo "    User Pool ID: $POOL_ID"

echo "==> Creating App Client (public — no client secret)..."
CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --region "$REGION" \
  --client-name docusaurus-auth-client \
  --no-generate-secret \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-ur-ls "$CALLBACK_URL" \
  --supported-identity-providers COGNITO \
  --query 'UserPoolClient.ClientId' \
  --output text)

echo "    Client ID: $CLIENT_ID"

echo "==> Creating Hosted UI domain: $DOMAIN_PREFIX"
aws cognito-idp create-user-pool-domain \
  --domain "$DOMAIN_PREFIX" \
  --user-pool-id "$POOL_ID" \
  --region "$REGION"

echo ""
echo "==> Done. Add these to your .env:"
echo "    USER_POOL_ID=$POOL_ID"
echo "    CLIENT_ID=$CLIENT_ID"
echo "    COGNITO_DOMAIN=$DOMAIN_PREFIX.auth.$REGION.amazoncognito.com"
