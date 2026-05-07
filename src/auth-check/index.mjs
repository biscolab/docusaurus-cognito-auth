import { validateToken } from './jwt-validator.mjs';
import { config } from './config.mjs';

/**
 * Parses the Cookie request header into a key-value map.
 *
 * @param {Record<string, Array<{key: string, value: string}>>} headers - CloudFront request headers.
 * @returns {Record<string, string>} Parsed cookie map.
 */
function parseCookies(headers) {
  const cookieHeader = headers.cookie;
  if (!cookieHeader) return {};
  return cookieHeader[0].value.split(';').reduce((acc, cookie) => {
    const [key, ...val] = cookie.trim().split('=');
    acc[key.trim()] = val.join('=');
    return acc;
  }, {});
}

/**
 * Builds the Cognito Hosted UI authorization URL.
 *
 * @param {string} originalUri - The URI the user originally requested; used as the OAuth state parameter.
 * @returns {string} Full Cognito authorize URL.
 */
function buildLoginUrl(originalUri) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: 'openid email profile',
    state: originalUri || '/',
  });
  return `https://${config.cognitoDomain}/oauth2/authorize?${params}`;
}

/**
 * Returns a 302 redirect response pointing to the Cognito login page.
 * Clears the auth_token cookie if clearCookie is true (invalid/expired token case).
 *
 * @param {string} loginUrl - Cognito authorize URL.
 * @param {boolean} [clearCookie=false] - Whether to expire the existing cookie.
 * @returns {object} CloudFront response object.
 */
function redirectToLogin(loginUrl, clearCookie = false) {
  const headers = {
    location: [{ key: 'Location', value: loginUrl }],
    'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
  };

  if (clearCookie) {
    headers['set-cookie'] = [
      {
        key: 'Set-Cookie',
        value: 'auth_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      },
    ];
  }

  return { status: '302', statusDescription: 'Found', headers };
}

/**
 * Clears the auth_token cookie and redirects to the Cognito logout endpoint,
 * which invalidates the Cognito session and redirects back to the site root.
 *
 * @returns {object} CloudFront response object.
 */
function logout() {
  const logoutUrl =
    `https://${config.cognitoDomain}/logout` +
    `?client_id=${config.clientId}` +
    `&logout_uri=${encodeURIComponent(config.logoutUrl)}`;

  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: logoutUrl }],
      'set-cookie': [
        {
          key: 'Set-Cookie',
          value: 'auth_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
        },
      ],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
    },
  };
}

/**
 * Lambda@Edge viewer-request handler.
 * Checks every incoming CloudFront request for a valid auth_token cookie.
 * Passes the request through to S3 if valid; redirects to Cognito otherwise.
 * Handles /logout by clearing the cookie and ending the Cognito session.
 *
 * @param {{ Records: Array<{ cf: { request: object } }> }} event - CloudFront event.
 * @returns {Promise<object>} The original CloudFront request (passthrough) or a redirect response.
 */
export async function handler(event) {
  const request = event.Records[0].cf.request;

  if (request.uri === '/logout') {
    return logout();
  }

  const cookies = parseCookies(request.headers);
  const token = cookies['auth_token'];

  if (!token) {
    return redirectToLogin(buildLoginUrl(request.uri));
  }

  try {
    await validateToken(token, config);
    return request;
  } catch {
    return redirectToLogin(buildLoginUrl(request.uri), true);
  }
}
