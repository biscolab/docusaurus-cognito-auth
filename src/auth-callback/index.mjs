import { config } from './config.mjs';

/**
 * Parses a CloudFront querystring into a key-value map.
 *
 * @param {string} querystring - Raw querystring from the CloudFront request (no leading '?').
 * @returns {Record<string, string>} Parsed parameters.
 */
function parseQueryString(querystring) {
  if (!querystring) return {};
  return Object.fromEntries(new URLSearchParams(querystring));
}

/**
 * Exchanges a Cognito authorization code for tokens via the token endpoint.
 * Uses a public client (no client_secret) — configure the Cognito App Client accordingly.
 *
 * @param {string} code - The authorization code from the Cognito callback.
 * @returns {Promise<{ id_token: string, access_token: string, expires_in: number }>} Token response.
 * @throws {Error} When the token endpoint returns a non-2xx response.
 */
async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
  });

  const response = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${detail}`);
  }

  return response.json();
}

/**
 * Builds the Cognito login URL for redirecting the user after an error.
 *
 * @returns {string} Cognito authorize URL.
 */
function buildLoginUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: 'openid email profile',
  });
  return `https://${config.cognitoDomain}/oauth2/authorize?${params}`;
}

/**
 * Lambda@Edge viewer-request handler for the /callback path.
 * Exchanges the Cognito authorization code for tokens, sets a secure HttpOnly cookie,
 * and redirects the user to their originally requested page.
 *
 * @param {{ Records: Array<{ cf: { request: object } }> }} event - CloudFront event.
 * @returns {Promise<object>} A 302 redirect CloudFront response.
 */
export async function handler(event) {
  const request = event.Records[0].cf.request;
  const params = parseQueryString(request.querystring);
  const { code, state } = params;

  if (!code) {
    return {
      status: '400',
      statusDescription: 'Bad Request',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/plain' }],
        'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store' }],
      },
      body: 'Missing authorization code.',
    };
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const redirectTo = state || '/';
    const maxAge = tokens.expires_in || 3600;

    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{ key: 'Location', value: redirectTo }],
        'set-cookie': [
          {
            key: 'Set-Cookie',
            value: `auth_token=${tokens.id_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
          },
        ],
        'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    };
  } catch (error) {
    console.error('Token exchange error:', error.message);
    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{ key: 'Location', value: buildLoginUrl() }],
        'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store' }],
      },
    };
  }
}
