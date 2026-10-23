/** Portable WebCrypto helpers. Keys are supplied by the server, never read here. */
export interface GoogleSecretEnvelope {
  v: 1;
  kid: string;
  iv: string;
  ciphertext: string;
}

export interface GoogleSecretContext {
  /** Unpadded base64url encoding of exactly 32 random bytes. */
  key: string;
  keyId: string;
  purpose: string;
  userId: string;
  generation: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const secretLimit = 32_768;

export class GoogleCryptoError extends Error {
  constructor() {
    super('No se pudo proteger o verificar la conexión de Google.');
    this.name = 'GoogleCryptoError';
  }
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string, maximum: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > maximum * 2) {
    throw new GoogleCryptoError();
  }
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length > maximum || encode(bytes) !== value) throw new GoogleCryptoError();
  return bytes;
}

function contextData(context: GoogleSecretContext): Uint8Array<ArrayBuffer> {
  for (const value of [context.keyId, context.purpose, context.userId, context.generation]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
      throw new GoogleCryptoError();
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(context.keyId)) throw new GoogleCryptoError();
  return encoder.encode(JSON.stringify(['tr8.google.v1', context.purpose, context.userId, context.generation, context.keyId]));
}

async function importKey(encoded: string): Promise<CryptoKey> {
  const bytes = decode(encoded, 32);
  if (bytes.length !== 32) throw new GoogleCryptoError();
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Cryptographically random, unpadded base64url. The default has 256 bits of entropy. */
export function randomBase64Url(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 96) throw new GoogleCryptoError();
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  if (typeof value !== 'string' || value.length > secretLimit) throw new GoogleCryptoError();
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/** RFC 7636 S256 verifier/challenge; the verifier stays on the server. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url();
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

/** AES-256-GCM binds each secret to its purpose, account, connection generation and key version. */
export async function encryptGoogleSecret(input: GoogleSecretContext & { plaintext: string }): Promise<GoogleSecretEnvelope> {
  try {
    const additionalData = contextData(input);
    if (typeof input.plaintext !== 'string') throw new GoogleCryptoError();
    const plaintext = encoder.encode(input.plaintext);
    if (plaintext.length < 1 || plaintext.length > secretLimit) throw new GoogleCryptoError();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, await importKey(input.key), plaintext);
    return { v: 1, kid: input.keyId, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  } catch {
    throw new GoogleCryptoError();
  }
}

export async function decryptGoogleSecret(input: GoogleSecretContext & { envelope: GoogleSecretEnvelope }): Promise<string> {
  try {
    const additionalData = contextData(input);
    const envelope = input.envelope;
    if (!envelope || envelope.v !== 1 || envelope.kid !== input.keyId) throw new GoogleCryptoError();
    const iv = decode(envelope.iv, 12);
    const ciphertext = decode(envelope.ciphertext, secretLimit + 16);
    if (iv.length !== 12 || ciphertext.length < 17) throw new GoogleCryptoError();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, await importKey(input.key), ciphertext);
    return decoder.decode(plaintext);
  } catch {
    throw new GoogleCryptoError();
  }
}
