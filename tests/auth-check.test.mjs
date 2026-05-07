import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/auth-check/jwt-validator.mjs', () => ({
  validateToken: vi.fn(),
}));

vi.mock('../src/auth-check/config.mjs', () => ({
  config: {
    region: 'us-east-1',
    userPoolId: 'us-east-1_testPool',
    clientId: 'test-client-id',
    cognitoDomain: 'test.auth.us-east-1.amazoncognito.com',
    callbackUrl: 'https://test.cloudfront.net/callback',
    logoutUrl: 'https://test.cloudfront.net',
  },
}));

const { handler } = await import('../src/auth-check/index.mjs');
const { validateToken } = await import('../src/auth-check/jwt-validator.mjs');

/**
 * Builds a minimal CloudFront viewer-request event.
 *
 * @param {{ uri?: string, cookie?: string }} [opts]
 * @returns {object} CloudFront event.
 */
function makeEvent({ uri = '/', cookie = null } = {}) {
  const headers = {};
  if (cookie) {
    headers.cookie = [{ key: 'Cookie', value: cookie }];
  }
  return {
    Records: [
      {
        cf: {
          request: {
            uri,
            querystring: '',
            method: 'GET',
            headers,
          },
        },
      },
    ],
  };
}

describe('auth-check handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when no cookie is present', () => {
    it('returns a 302 redirect to Cognito', async () => {
      const event = makeEvent({ uri: '/protected' });
      const response = await handler(event);

      expect(response.status).toBe('302');
      expect(response.statusDescription).toBe('Found');
    });

    it('redirect URL targets the Cognito authorize endpoint', async () => {
      const event = makeEvent();
      const response = await handler(event);

      expect(response.headers.location[0].value).toContain('oauth2/authorize');
    });

    it('encodes the original URI as the OAuth state parameter', async () => {
      const event = makeEvent({ uri: '/docs/intro' });
      const response = await handler(event);

      expect(response.headers.location[0].value).toContain('state=%2Fdocs%2Fintro');
    });

    it('does not attempt JWT validation', async () => {
      await handler(makeEvent());
      expect(validateToken).not.toHaveBeenCalled();
    });
  });

  describe('when a valid auth_token cookie is present', () => {
    it('passes the original request through to S3', async () => {
      validateToken.mockResolvedValueOnce({ sub: 'user-123' });
      const event = makeEvent({ cookie: 'auth_token=valid.jwt.token' });

      const response = await handler(event);

      expect(response).toEqual(event.Records[0].cf.request);
    });

    it('calls validateToken with the extracted token and config', async () => {
      validateToken.mockResolvedValueOnce({ sub: 'user-123' });
      await handler(makeEvent({ cookie: 'auth_token=my.jwt.here; other=val' }));

      expect(validateToken).toHaveBeenCalledWith(
        'my.jwt.here',
        expect.objectContaining({
          clientId: 'test-client-id',
        })
      );
    });
  });

  describe('when the auth_token cookie is invalid or expired', () => {
    it('returns a 302 redirect to Cognito', async () => {
      validateToken.mockRejectedValueOnce(new Error('JWTExpired'));
      const response = await handler(makeEvent({ cookie: 'auth_token=expired.jwt.token' }));

      expect(response.status).toBe('302');
    });

    it('expires the invalid cookie in the redirect response', async () => {
      validateToken.mockRejectedValueOnce(new Error('JWTExpired'));
      const response = await handler(makeEvent({ cookie: 'auth_token=expired.jwt.token' }));

      const setCookie = response.headers['set-cookie'][0].value;
      expect(setCookie).toContain('auth_token=');
      expect(setCookie).toContain('Max-Age=0');
    });

    it('includes Cache-Control: no-cache in the response', async () => {
      validateToken.mockRejectedValueOnce(new Error('invalid'));
      const response = await handler(makeEvent({ cookie: 'auth_token=bad' }));

      expect(response.headers['cache-control'][0].value).toContain('no-cache');
    });
  });

  describe('logout (/logout path)', () => {
    it('returns a 302 redirect to the Cognito logout endpoint', async () => {
      const response = await handler(makeEvent({ uri: '/logout' }));

      expect(response.status).toBe('302');
      expect(response.headers.location[0].value).toContain('/logout');
      expect(response.headers.location[0].value).toContain('client_id=test-client-id');
    });

    it('clears the auth_token cookie', async () => {
      const response = await handler(makeEvent({ uri: '/logout' }));

      const setCookie = response.headers['set-cookie'][0].value;
      expect(setCookie).toContain('auth_token=');
      expect(setCookie).toContain('Max-Age=0');
    });

    it('encodes the logout_uri in the redirect URL', async () => {
      const response = await handler(makeEvent({ uri: '/logout' }));

      expect(response.headers.location[0].value).toContain(
        encodeURIComponent('https://test.cloudfront.net')
      );
    });

    it('does not validate the token', async () => {
      await handler(makeEvent({ uri: '/logout' }));
      expect(validateToken).not.toHaveBeenCalled();
    });
  });

  describe('cookie parsing', () => {
    it('correctly extracts auth_token from a multi-cookie header', async () => {
      validateToken.mockResolvedValueOnce({ sub: 'u1' });
      await handler(makeEvent({ cookie: 'session=abc; auth_token=my.token.here; pref=dark' }));

      expect(validateToken).toHaveBeenCalledWith('my.token.here', expect.any(Object));
    });

    it('handles cookies with = in the value (base64 padding)', async () => {
      validateToken.mockResolvedValueOnce({ sub: 'u1' });
      await handler(makeEvent({ cookie: 'auth_token=abc==; other=x' }));

      expect(validateToken).toHaveBeenCalledWith('abc==', expect.any(Object));
    });
  });
});
