// The healthchecks.io heartbeat (requirements 12): pinged only after a full success, so a missing
// ping raises the alarm. The check's URL is its secret (anyone with it can ping): it never appears
// in a log, neither whole nor its path.
import { HttpError, PoliteHttp, type PoliteHttpOptions, causeCode, redactUrl } from '../http';
import type { Logger } from '../types';

/** The parts of a ping URL that are secret: the whole URL and each path part (the check's id). */
function secretParts(url: string): string[] {
  const parts = [url, redactUrl(url)];
  try {
    const u = new URL(url);
    parts.push(u.pathname, ...u.pathname.split('/'), u.search);
  } catch {
    // Not a URL: only the text as given is masked.
  }
  // Longest first, so a part inside a longer one never leaves the rest of it behind.
  return [...new Set(parts.filter((p) => p.length >= 4))].sort((a, b) => b.length - a.length);
}

/**
 * Why a ping failed, without the URL: for an HTTP answer its status; otherwise the error's message
 * with every secret part masked, and the cause's error code when known (e.g. `ETIMEDOUT`).
 */
export function heartbeatFailure(e: unknown, url: string): { error: string; cause?: string } {
  if (e instanceof HttpError) return { error: `HTTP ${e.status}` };
  let error = e instanceof Error ? e.message : 'error';
  for (const part of secretParts(url)) error = error.replaceAll(part, '***');
  const code = causeCode(e);
  return { error, ...(code && { cause: code }) };
}

/**
 * Pings the check's URL; true when it answered. A failure is logged as a warning (`check`: the
 * setting's name, never its value) and returns false, so the caller can try again later.
 */
export async function sendHeartbeat(
  url: string,
  check: string,
  log: Logger,
  options: Pick<PoliteHttpOptions, 'fetchImpl' | 'sleep'> = {},
): Promise<boolean> {
  try {
    // The secret parts are registered too, so every error the client builds is masked already.
    await new PoliteHttp({ retries: 2, secrets: secretParts(url), ...options }).text(url);
    return true;
  } catch (e) {
    log.warn('Heartbeat ping failed', { check, ...heartbeatFailure(e, url) });
    return false;
  }
}
