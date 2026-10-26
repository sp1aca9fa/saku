import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashPassword,
  hotp,
  matchBackupCode,
  normalizeUsername,
  otpauthUri,
  totpCode,
  totpStep,
  verifyPassword,
  verifyTotp,
} from './index';

describe('TOTP', () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (8-digit values; we use the last 6).
  const seed = Buffer.from('12345678901234567890');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches the RFC vector at %i s', (seconds, expected) => {
    expect(hotp(seed, Math.floor(seconds / 30), 8)).toBe(expected);
    expect(hotp(seed, Math.floor(seconds / 30))).toBe(expected.slice(2));
  });

  it('round-trips base32', () => {
    expect(base32Encode(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(seed)).toBe(true);
  });

  it('verifies within the drift window and rejects replays', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-10-09T12:00:00Z');
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, { now });
    expect(step).toBe(totpStep(now));
    expect(verifyTotp(secret, code, { now: new Date(now.getTime() + 30_000) })).toBe(step);
    expect(verifyTotp(secret, code, { now: new Date(now.getTime() + 90_000) })).toBeNull();
    expect(verifyTotp(secret, code, { now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
  });

  it('builds an otpauth URI', () => {
    expect(otpauthUri('ABC', 'alice')).toBe(
      'otpauth://totp/Saku%3Aalice?secret=ABC&issuer=Saku&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secrets at rest', () => {
  it('encrypts and decrypts; fails with another key or tampering', () => {
    const key = 'k'.repeat(32);
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(enc, 'x'.repeat(32))).toThrow();
    // Flip one bit of the first ciphertext byte (always a real change, unlike overwriting text).
    const [v, iv, tag, ct] = enc.split('.');
    const bytes = Buffer.from(ct!, 'base64url');
    bytes[0]! ^= 1;
    const tampered = [v, iv, tag, bytes.toString('base64url')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});

describe('backup codes', () => {
  it('match once by hash, ignoring case and dashes', () => {
    const { codes, hashes } = generateBackupCodes();
    expect(codes).toHaveLength(8);
    expect(matchBackupCode(codes[3]!.toUpperCase().replace('-', ' '), hashes)).toBe(3);
    expect(matchBackupCode('aaaaa-bbbbb', hashes)).toBe(-1);
  });
});

describe('password', () => {
  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).not.toContain('$');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:a:b:c:d:e')).toBe(false);
  });
});

describe('usernames', () => {
  it('normalizes and validates', () => {
    expect(normalizeUsername(' Alice ')).toBe('alice');
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('a b c')).toBeNull();
  });
});
