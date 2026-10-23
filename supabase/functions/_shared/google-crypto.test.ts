// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decryptGoogleSecret, encryptGoogleSecret, generatePkce, GoogleCryptoError, randomBase64Url, sha256Base64Url } from './google-crypto';

const context = {
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  keyId: 'key-v1',
  purpose: 'google-tokens',
  userId: 'e351658c-e40a-40e2-a764-00821ea26583',
  generation: 'd845c868-044c-41eb-8870-39daa50c7da8',
};

describe('Google secret encryption', () => {
  it('round trips without placing plaintext in the envelope and uses fresh nonces', async () => {
    const plaintext = JSON.stringify({ refreshToken: 'synthetic-refresh-ñ' });
    const first = await encryptGoogleSecret({ ...context, plaintext });
    const second = await encryptGoogleSecret({ ...context, plaintext });
    expect(first.v).toBe(1);
    expect(first.kid).toBe(context.keyId);
    expect(JSON.stringify(first)).not.toContain('synthetic-refresh');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptGoogleSecret({ ...context, envelope: first })).toBe(plaintext);
  });

  it.each([
    { purpose: 'oauth-verifier' },
    { userId: 'another-user' },
    { generation: 'another-generation' },
    { keyId: 'key-v2' },
    { key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
  ])('binds ciphertext to its owner, generation, purpose and key %j', async change => {
    const envelope = await encryptGoogleSecret({ ...context, plaintext: 'synthetic-secret' });
    await expect(decryptGoogleSecret({ ...context, ...change, envelope })).rejects.toThrow(GoogleCryptoError);
  });

  it('rejects modified tags, IVs and unsupported envelopes with a sanitized error', async () => {
    const envelope = await encryptGoogleSecret({ ...context, plaintext: 'synthetic-sensitive-value' });
    const variants = [
      { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` },
      { ...envelope, ciphertext: 'AA' },
      { ...envelope, iv: 'AA' },
      { ...envelope, v: 2 },
    ];
    for (const variant of variants) {
      const error = await decryptGoogleSecret({ ...context, envelope: variant as typeof envelope }).catch(value => value);
      expect(error).toBeInstanceOf(GoogleCryptoError);
      expect(String(error)).not.toContain('synthetic-sensitive-value');
    }
  });

  it.each(['AA', `${context.key}=`, 'invalid+base64', 'A'.repeat(200)])('rejects invalid key material %s', async key => {
    await expect(encryptGoogleSecret({ ...context, key, plaintext: 'secret' })).rejects.toThrow(GoogleCryptoError);
  });

  it('bounds plaintext bytes rather than string characters', async () => {
    await expect(encryptGoogleSecret({ ...context, plaintext: 'ñ'.repeat(20_000) })).rejects.toThrow(GoogleCryptoError);
  });
});

describe('OAuth random state and PKCE', () => {
  it('matches the RFC 7636 S256 test vector', async () => {
    expect(await sha256Base64Url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates independent URL-safe state and 43-character verifiers/challenges', async () => {
    const first = await generatePkce();
    const second = await generatePkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toBe(await sha256Base64Url(first.verifier));
    expect(randomBase64Url()).not.toBe(randomBase64Url());
  });

  it.each([0, 31, 97, 32.5])('rejects weak or unbounded random lengths %s', length => {
    expect(() => randomBase64Url(length)).toThrow(GoogleCryptoError);
  });
});
