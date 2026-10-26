import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Format: `scrypt:N:r:p:<salt base64url>:<hash base64url>`. No `$` characters, because
 * Next.js expands `$VAR` inside .env files.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, hashText] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEM };
  if (![params.N, params.r, params.p].every(Number.isSafeInteger)) return false;

  const expected = Buffer.from(hashText, 'base64url');
  if (expected.length === 0) return false;
  try {
    const actual = await scryptAsync(
      password,
      Buffer.from(saltText, 'base64url'),
      expected.length,
      params,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
