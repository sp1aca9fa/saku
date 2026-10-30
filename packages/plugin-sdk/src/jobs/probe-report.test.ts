import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProbeLine } from './probe';
import { closeInstant, probeReport, readProbeFile } from './probe-report';

const bar = (at: string, date: string, close: number, source = 'alpha'): ProbeLine => ({
  at,
  source,
  ticker: 'T',
  date,
  close,
  divCash: 0,
});

describe('closeInstant', () => {
  it('is 16:00 New York on both sides of daylight saving time', () => {
    expect(new Date(closeInstant('2026-03-06')).toISOString()).toBe('2026-03-06T21:00:00.000Z');
    expect(new Date(closeInstant('2026-03-09')).toISOString()).toBe('2026-03-09T20:00:00.000Z');
    expect(new Date(closeInstant('2026-10-30')).toISOString()).toBe('2026-10-30T20:00:00.000Z');
    expect(new Date(closeInstant('2026-11-02')).toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });
});

describe('probeReport', () => {
  const lines: ProbeLine[] = [
    // Winter date: close 21:00Z. Seen 21:30Z, changed 23:30Z, stable after.
    bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10),
    bar('2026-03-06T23:30:00.000Z', '2026-03-06', 10.5),
    bar('2026-03-07T10:00:00.000Z', '2026-03-06', 10.5),
    // Summer date: close 20:00Z. First seen 19:00Z (before the close), never changed.
    bar('2026-03-09T19:00:00.000Z', '2026-03-09', 11),
    bar('2026-03-09T20:30:00.000Z', '2026-03-09', 11),
    bar('2026-03-10T21:00:00.000Z', '2026-03-10', 12),
    { at: '2026-03-09T20:30:00.000Z', source: 'alpha', ticker: 'T', error: 'rate limited' },
    { at: '2026-03-09T21:30:00.000Z', source: 'alpha', ticker: 'T', error: 'rate limited' },
    { at: '2026-03-09T22:30:00.000Z', source: 'alpha', ticker: 'T', error: 'no bars' },
  ].sort((a, b) => a.at.localeCompare(b.at));

  it('lists times and minutes after the close, the summary and the resolution', () => {
    const text = probeReport({ lines, unreadable: 0 });
    expect(text).toContain('at most one hour late');
    expect(text).toMatch(/2026-03-06\s+2026-03-06 16:30\s+30\s+2026-03-06 18:30\s+150\s+1\s*$/m);
    expect(text).toMatch(/2026-03-09\s+2026-03-09 15:00\s+-60\s+2026-03-09 15:00\s+-60\s+0\s*$/m);
    expect(text).toMatch(/2026-03-10 .*\s0\s+may still change/);
    expect(text).toContain('dates seen 3');
    expect(text).toContain('median 45 min, maximum 150 min (1 left out, may still change)');
    expect(text).toContain('error lines 3, most frequent: rate limited (2x)');
  });

  it('filters by --from and reports unreadable lines', () => {
    const text = probeReport({ lines, unreadable: 2, from: '2026-03-09' });
    expect(text).toContain('Unreadable lines in the file (not counted below): 2.');
    expect(text).toContain('dates seen 2');
    expect(text).not.toMatch(/^2026-03-06/m);
  });

  it('says so with no lines', () => {
    expect(probeReport({ lines: [], unreadable: 0 })).toContain('No probe lines.');
  });
});

describe('readProbeFile', () => {
  it('counts lines that are not JSON or lack the fields', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'probe-')), 'probe.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify(bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10)),
        '{not json',
        JSON.stringify({ source: 'a' }),
        JSON.stringify({ at: 'x', source: 'a' }),
        '',
      ].join('\n'),
    );
    const r = readProbeFile(file);
    expect(r.lines).toHaveLength(1);
    expect(r.unreadable).toBe(3);
  });
});
