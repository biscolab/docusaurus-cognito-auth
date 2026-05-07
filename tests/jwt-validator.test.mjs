import { vi, describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

// Keep a module-level reference so the mock factory's closure picks it up at call time.
let validKeyPair;
let invalidKeyPair;

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Return a GetKeyFunction that always resolves to the valid public key.
    // Tests that need to fail signature verification sign with invalidKeyPair.privateKey instead.
    createRemoteJWKSet: vi.fn().mockImplementation(() => async () => validKeyPair?.publicKey),
  };
});

// Import after mock registration so jwt-validator.mjs gets the mocked createRemoteJWKSet.
const { validateToken } = await import('../src/auth-check/jwt-validator.mjs');

const TEST_CONFIG = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_testPool123',
  clientId: 'test-client-id',
};

const VALID_ISSUER = `https://cognito-idp.${TEST_CONFIG.region}.amazonaws.com/${TEST_CONFIG.userPoolId}`;

/**
 * Signs a test JWT using the given private key with configurable claims.
 *
 * @param {CryptoKey} privateKey - RSA private key to sign with.
 * @param {object} [overrides] - Claim overrides.
 * @returns {Promise<string>} Signed JWT.
 */
async function signToken(privateKey, overrides = {}) {
  const {
    sub = 'user-123',
    aud = TEST_CONFIG.clientId,
    iss = VALID_ISSUER,
    expirationTime = '1h',
  } = overrides;

  const builder = new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud);

  if (expirationTime !== null) {
    builder.setExpirationTime(expirationTime);
  }

  return builder.sign(privateKey);
}

beforeAll(async () => {
  [validKeyPair, invalidKeyPair] = await Promise.all([
    generateKeyPair('RS256'),
    generateKeyPair('RS256'),
  ]);
});

describe('validateToken', () => {
  it('returns the decoded payload for a valid JWT', async () => {
    const token = await signToken(validKeyPair.privateKey);
    const payload = await validateToken(token, TEST_CONFIG);

    expect(payload.sub).toBe('user-123');
    expect(payload.iss).toBe(VALID_ISSUER);
    expect(payload.aud).toBe(TEST_CONFIG.clientId);
  });

  it('throws for an expired JWT', async () => {
    const token = await signToken(validKeyPair.privateKey, {
      expirationTime: Math.floor(Date.now() / 1000) - 3600,
    });

    await expect(validateToken(token, TEST_CONFIG)).rejects.toThrow();
  });

  it('throws for a JWT with wrong audience', async () => {
    const token = await signToken(validKeyPair.privateKey, { aud: 'wrong-client-id' });

    await expect(validateToken(token, TEST_CONFIG)).rejects.toThrow();
  });

  it('throws for a JWT with wrong issuer', async () => {
    const token = await signToken(validKeyPair.privateKey, {
      iss: 'https://evil.cognito.amazonaws.com/wrong-pool',
    });

    await expect(validateToken(token, TEST_CONFIG)).rejects.toThrow();
  });

  it('throws for a JWT signed with a different private key', async () => {
    // Signed with invalid key; JWKS returns valid public key → signature mismatch.
    const token = await signToken(invalidKeyPair.privateKey);

    await expect(validateToken(token, TEST_CONFIG)).rejects.toThrow();
  });
});
