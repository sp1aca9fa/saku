import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lock, readStamp, writeStamp } from './lock';

describe('lock', () => {
  it('lets one holder in and takes over a dead holder’s lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-lock-'));
    const first = lock('daily', dir);
    expect('release' in first).toBe(true);
    expect(lock('daily', dir, process.pid + 1)).toEqual({ heldBy: process.pid });
    if ('release' in first) first.release();
    expect('release' in lock('daily', dir, 999_999_999)).toBe(true);
    // A process ID that no longer exists: taken over.
    expect('release' in lock('daily', dir)).toBe(true);
  });
});

describe('stamps', () => {
  it('round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-stamp-'));
    expect(readStamp('daily', dir)).toBeNull();
    writeStamp('daily', '2026-01-05', dir);
    expect(readStamp('daily', dir)).toBe('2026-01-05');
  });
});
