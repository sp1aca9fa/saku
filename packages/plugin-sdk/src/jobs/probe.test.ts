import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyPlugins } from '../registry';
import type { BarSource } from '../types';
import { finalization, probe } from './probe';

const source = (
  key: string,
  fetch: () => Promise<{ date: string; close: number }[]>,
): BarSource => ({
  info: { key, kind: 'bar', name: key, provides: {}, suggestedRole: 'secondary', termsUrl: 'x' },
  fetchBars: async () =>
    (await fetch()).map((b) => ({ ...b, closeIsSplitAdjusted: false, divCash: 0, splitFactor: 1 })),
});

describe('probe', () => {
  it('appends what each source returned, and errors, to the probe file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saku-probe-')), 'probe.jsonl');
    const plugins = {
      ...emptyPlugins(),
      bars: [
        source('a', async () => [{ date: '2026-01-05', close: 10 }]),
        source('b', async () => {
          throw new Error('HTTP 503');
        }),
      ],
    };
    await probe(plugins, {
      ticker: 'AAA',
      from: '2026-01-01',
      to: '2026-01-05',
      context: () => ({ http: undefined as never, now: new Date(), log: { info() {}, warn() {} } }),
      now: () => new Date('2026-01-05T22:20:00Z'),
      file,
    });
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        at: '2026-01-05T22:20:00.000Z',
        source: 'a',
        ticker: 'AAA',
        date: '2026-01-05',
        close: 10,
        divCash: 0,
      },
      { at: '2026-01-05T22:20:00.000Z', source: 'b', ticker: 'AAA', error: 'HTTP 503' },
    ]);
  });

  it('finds when a bar first appeared and last changed', () => {
    const l = (at: string, close: number) => ({ at, source: 'a', ticker: 'AAA', date: 'd', close });
    expect(finalization([l('t1', 10), l('t2', 10.1), l('t3', 10.1), l('t4', 10.1)])).toEqual([
      { source: 'a', date: 'd', first: 't1', lastChange: 't2', changes: 1 },
    ]);
  });
});
