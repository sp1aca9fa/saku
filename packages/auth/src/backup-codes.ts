import { randomInt } from 'node:crypto';
import { sha256 } from './crypto';

// No 0/o, 1/l/i: easy to read back from paper.
const CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function normalize(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One-time recovery codes like `k7m2-9qxd` (~50 bits each). Only their hashes are stored. */
export function generateBackupCodes(count = 8): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = Array.from({ length: 10 }, () => CHARS[randomInt(CHARS.length)]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(normalize(c))) };
}

/** Index of the matching stored hash, or -1. */
export function matchBackupCode(code: string, hashes: readonly string[]): number {
  const n = normalize(code);
  if (n.length !== 10) return -1;
  return hashes.indexOf(sha256(n));
}

export function looksLikeBackupCode(code: string): boolean {
  return normalize(code).length === 10 && /[a-z]/i.test(code);
}
