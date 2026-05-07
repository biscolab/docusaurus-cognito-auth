import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Module-level JWKS cache — populated on first call and reused across invocations. */
let jwks;

/**
 * Validates a Cognito-issued JWT against the pool's JWKS endpoint.
 *
 * @param {string} token - The JWT string extracted from the auth_token cookie.
 * @param {{ region: string, userPoolId: string, clientId: string }} config - Cognito pool config.
 * @returns {Promise<import('jose').JWTPayload>} Decoded and verified JWT payload.
 * @throws {Error} When the token is invalid, expired, or cannot be verified.
 */
export async function validateToken(token, config) {
  if (!jwks) {
    const jwksUrl = new URL(
      `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}/.well-known/jwks.json`
    );
    jwks = createRemoteJWKSet(jwksUrl);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
    audience: config.clientId,
  });

  return payload;
}
