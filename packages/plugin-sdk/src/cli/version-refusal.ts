import { StoredStrategy } from '@saku/core';

/**
 * For `pnpm strategy list`: a stored version whose content the current schema no longer parses
 * (versions are immutable, so a stricter schema can refuse an old one) gets this note with the
 * first issue (unreadable JSON too); a version that still parses gets undefined.
 */
export function refusalNote(version: { canonicalJson: string }): string | undefined {
  let stored: unknown;
  try {
    stored = (JSON.parse(version.canonicalJson) as { strategy?: unknown }).strategy;
  } catch (e) {
    return `  REFUSED by the current schema: ${e instanceof Error ? e.message : String(e)}`;
  }
  // As stored versions are read (forward.ts `parseVersion`): limits added later do not apply.
  const parsed = StoredStrategy.safeParse(stored);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `  REFUSED by the current schema: ${where}${issue?.message ?? 'unreadable'}`;
}
