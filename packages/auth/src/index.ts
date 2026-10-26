export * from './password';
export * from './totp';
export * from './crypto';
export * from './backup-codes';

/** Usernames: lowercase letters, digits, `.`, `_`, `-`; 3 to 32 characters. */
export function normalizeUsername(input: string): string | null {
  const u = input.trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(u) ? u : null;
}
