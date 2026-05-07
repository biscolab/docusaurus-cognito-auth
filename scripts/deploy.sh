#!/usr/bin/env bash
# Deploy docusaurus-cognito-auth to AWS.
# Lambda@Edge requires us-east-1; samconfig.toml enforces this.
#
# First deploy  → bootstraps all resources, auto-populates .env, then redeploys
#                  with the real CloudFront domain baked into Lambda and Cognito.
# Subsequent deploys → standard update (no second pass unless CALLBACK_URL changed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Read deploy settings from samconfig.toml ──────────────────────────────
_toml_value() { grep -m1 "$1" samconfig.toml | sed 's/.*= *"\([^"]*\)".*/\1/'; }
STACK_NAME=$(_toml_value "stack_name")
DEPLOY_REGION=$(_toml_value "region")
DEPLOY_PROFILE=$(_toml_value "profile")
COGNITO_PREFIX=$(grep -m1 "CognitoDomainPrefix" samconfig.toml | sed 's/.*CognitoDomainPrefix=\([^",]*\).*/\1/')

# ── Load .env if present ───────────────────────────────────────────────────
[[ -f "$ROOT/.env" ]] && { set -o allexport; source "$ROOT/.env"; set +o allexport; }

PREV_CALLBACK="${CALLBACK_URL:-placeholder}"

_deploy() {
  local callback="${CALLBACK_URL:-placeholder}"
  echo "==> Generating Lambda config files from environment..."
  node scripts/build-config.mjs

  echo "==> Running SAM build..."
  sam build --parallel

  echo "==> Deploying to AWS (${DEPLOY_REGION}, profile: ${DEPLOY_PROFILE})..."
  sam deploy --parameter-overrides "CallbackUrl=${callback}" "$@"
}

_deploy "$@"

# ── Read CloudFormation outputs ────────────────────────────────────────────
echo ""
echo "==> Reading CloudFormation outputs..."

_cf_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region     "$DEPLOY_REGION" \
    --profile    "$DEPLOY_PROFILE" \
    --query      "Stacks[0].Outputs[?OutputKey==\`$1\`].OutputValue" \
    --output     text
}

CF_DOMAIN=$(_cf_output "CloudFrontDomain")
NEW_USER_POOL_ID=$(_cf_output "UserPoolId")
NEW_CLIENT_ID=$(_cf_output "UserPoolClientId")
NEW_COGNITO_DOMAIN="${COGNITO_PREFIX}.auth.${DEPLOY_REGION}.amazoncognito.com"
NEW_CALLBACK_URL="https://${CF_DOMAIN}/callback"

# ── Write .env with real values ────────────────────────────────────────────
cat > "$ROOT/.env" <<EOF
AWS_REGION=${DEPLOY_REGION}
USER_POOL_ID=${NEW_USER_POOL_ID}
CLIENT_ID=${NEW_CLIENT_ID}
COGNITO_DOMAIN=${NEW_COGNITO_DOMAIN}
CALLBACK_URL=${NEW_CALLBACK_URL}
EOF

echo "==> .env updated:"
echo "    USER_POOL_ID   = ${NEW_USER_POOL_ID}"
echo "    CLIENT_ID      = ${NEW_CLIENT_ID}"
echo "    COGNITO_DOMAIN = ${NEW_COGNITO_DOMAIN}"
echo "    CALLBACK_URL   = ${NEW_CALLBACK_URL}"

# ── Second deploy if CALLBACK_URL changed (first-time bootstrap) ───────────
if [[ "$PREV_CALLBACK" != "$NEW_CALLBACK_URL" ]]; then
  echo ""
  echo "==> First deploy detected — CALLBACK_URL has changed."
  echo "==> Running second deploy to wire real values into Lambda and Cognito..."

  export CALLBACK_URL="$NEW_CALLBACK_URL"
  export USER_POOL_ID="$NEW_USER_POOL_ID"
  export CLIENT_ID="$NEW_CLIENT_ID"
  export COGNITO_DOMAIN="$NEW_COGNITO_DOMAIN"
  export AWS_REGION="$DEPLOY_REGION"

  _deploy "$@"
fi

echo ""
echo "==> All done!"
echo "    Site:          https://${CF_DOMAIN}"
echo "    Cognito login: https://${NEW_COGNITO_DOMAIN}/login?client_id=${NEW_CLIENT_ID}&redirect_uri=${NEW_CALLBACK_URL}&response_type=code&scope=openid+email+profile"
echo "    S3 bucket:     $(_cf_output "SiteBucketName")"
