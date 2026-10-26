import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/** 32-byte key for a purpose, derived from AUTH_SECRET with HKDF. */
function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'saku', purpose, 32));
}

/**
 * AES-256-GCM encryption for secrets at rest (TOTP seeds). Format `v1.<iv>.<tag>.<ciphertext>`.
 * The key derives from AUTH_SECRET, so the web app and the CLI must share the same AUTH_SECRET.
 */
export function encryptSecret(plaintext: string, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(authSecret, 'totp-secret'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(payload: string, authSecret: string): string {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(authSecret, 'totp-secret'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

/** Keyed hash for identifiers stored in logs (IPs, usernames in login attempts). */
export function keyedHash(value: string, authSecret: string): string {
  return createHmac('sha256', deriveKey(authSecret, 'log-hash')).update(value).digest('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
