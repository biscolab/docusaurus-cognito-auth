import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/auth-callback/config.mjs', () => ({
  config: {
    region: 'us-east-1',
    userPoolId: 'us-east-1_testPool',
    clientId: 'test-client-id',
    cognitoDomain: 'test.auth.us-east-1.amazoncognito.com',
    callbackUrl: 'https://test.cloudfront.net/callback',
  },
}));

const { handler } = await import('../src/auth-callback/index.mjs');

const MOCK_TOKENS = {
  id_token: 'test.id.token',
  access_token: 'test.access.token',
  refresh_token: 'test.refresh.token',
  expires_in: 3600,
  token_type: 'Bearer',
};

/**
 * Builds a minimal CloudFront viewer-request event for the /callback path.
 *
 * @param {string} [querystring] - Raw query string (e.g. 'code=ABC&state=%2F').
 * @returns {object} CloudFront event.
 */
function makeCallbackEvent(querystring = '') {
  return {
    Records: [
      {
        cf: {
          request: {
            uri: '/callback',
            querystring,
            method: 'GET',
            headers: {},
          },
        },
      },
    ],
  };
}

/**
 * Stubs the global fetch with a successful token response.
 *
 * @param {object} [tokens] - Token response body override.
 * @returns {import('vitest').MockInstance} The fetch mock.
 */
function stubSuccessfulFetch(tokens = MOCK_TOKENS) {
  const mock = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => tokens,
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * Stubs the global fetch with a failed token response.
 *
 * @param {number} [status] - HTTP status code.
 * @param {string} [body] - Response body text.
 */
function stubFailedFetch(status = 400, body = 'invalid_grant') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => body,
    })
  );
}

describe('auth-callback handler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('when the authorization code is missing', () => {
    it('returns 400 Bad Request', async () => {
      const response = await handler(makeCallbackEvent(''));
      expect(response.status).toBe('400');
      expect(response.statusDescription).toBe('Bad Request');
    });

    it('includes a descriptive body', async () => {
      const response = await handler(makeCallbackEvent(''));
      expect(response.body).toMatch(/missing/i);
    });

    it('does not call the token endpoint', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      await handler(makeCallbackEvent(''));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('when code exchange succeeds', () => {
    it('returns a 302 redirect', async () => {
      stubSuccessfulFetch();
      const response = await handler(makeCallbackEvent('code=AUTH_CODE'));
      expect(response.status).toBe('302');
    });

    it('sets the auth_token cookie with id_token', async () => {
      stubSuccessfulFetch();
      const response = await handler(makeCallbackEvent('code=AUTH_CODE'));

      const cookie = response.headers['set-cookie'][0].value;
      expect(cookie).toContain(`auth_token=${MOCK_TOKENS.id_token}`);
    });

    it('sets HttpOnly, Secure, SameSite=Lax cookie attributes', async () => {
      stubSuccessfulFetch();
      const response = await handler(makeCallbackEvent('code=AUTH_CODE'));

      const cookie = response.headers['set-cookie'][0].value;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('sets Max-Age from expires_in', async () => {
      stubSuccessfulFetch({ ...MOCK_TOKENS, expires_in: 7200 });
      const response = await handler(makeCallbackEvent('code=AUTH_CODE'));

      expect(response.headers['set-cookie'][0].value).toContain('Max-Age=7200');
    });

    it('redirects to the state parameter URI when present', async () => {
      stubSuccessfulFetch();
      const response = await handler(makeCallbackEvent('code=AUTH_CODE&state=%2Fdocs%2Fintro'));

      expect(response.headers.location[0].value).toBe('/docs/intro');
    });

    it('redirects to / when state is absent', async () => {
      stubSuccessfulFetch();
      const response = await handler(makeCallbackEvent('code=AUTH_CODE'));

      expect(response.headers.location[0].value).toBe('/');
    });

    it('calls the Cognito token endpoint with correct parameters', async () => {
      const mockFetch = stubSuccessfulFetch();
      await handler(makeCallbackEvent('code=TEST_CODE_123'));

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('test.auth.us-east-1.amazoncognito.com/oauth2/token');
      expect(opts.method).toBe('POST');
      expect(opts.body).toContain('code=TEST_CODE_123');
      expect(opts.body).toContain('grant_type=authorization_code');
      expect(opts.body).toContain('client_id=test-client-id');
    });
  });

  describe('when code exchange fails', () => {
    it('returns a 302 redirect (not 500)', async () => {
      stubFailedFetch(400, 'invalid_grant');
      const response = await handler(makeCallbackEvent('code=BAD_CODE'));

      expect(response.status).toBe('302');
    });

    it('redirects to the Cognito login page on failure', async () => {
      stubFailedFetch();
      const response = await handler(makeCallbackEvent('code=BAD_CODE'));

      expect(response.headers.location[0].value).toContain('oauth2/authorize');
    });

    it('does not set a cookie on failure', async () => {
      stubFailedFetch();
      const response = await handler(makeCallbackEvent('code=BAD_CODE'));

      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });
});
