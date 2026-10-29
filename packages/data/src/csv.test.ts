import { describe, expect, it } from 'vitest';
import { Sessions } from './calendar';
import { parseBarsCsv } from './csv';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-01-19'],
});

describe('parseBarsCsv', () => {
  it('reads raw bars; open, high, low, volume, dividend and split are optional', () => {
    const csv =
      '\uFEFFDate,Open,High,Low,Close,Volume,Dividend,Split\r\n' +
      '2026-01-15,10,11,9.5,10.5,1000,,\r\n' +
      '2026-01-16,10.5,10.8,10.1,10.2,900,0.12,1\r\n';
    expect(parseBarsCsv(csv, sessions)).toEqual({
      errors: [],
      bars: [
        {
          date: '2026-01-15',
          open: 10,
          high: 11,
          low: 9.5,
          close: 10.5,
          closeIsSplitAdjusted: false,
          volume: 1000,
          divCash: 0,
          splitFactor: 1,
        },
        {
          date: '2026-01-16',
          open: 10.5,
          high: 10.8,
          low: 10.1,
          close: 10.2,
          closeIsSplitAdjusted: false,
          volume: 900,
          divCash: 0.12,
          splitFactor: 1,
        },
      ],
    });
    expect(parseBarsCsv('date,close\n2026-01-16,10\n', sessions).bars).toHaveLength(1);
  });

  it('never imports adjusted or derived columns', () => {
    const r = parseBarsCsv('date,close,adj close\n2026-01-16,10,9.9\n', sessions);
    expect(r.bars).toEqual([]);
    expect(r.errors[0]).toMatch(/unknown columns adj close/);
  });

  it('one bad row refuses the whole file, with line numbers', () => {
    const csv = [
      'date,high,low,close',
      '2026-01-14,11,9,10',
      '2026-01-15,11,9,1,234',
      '2026-01-16,11,9,abc',
      '2026-01-19,11,9,10',
      '2026-01-20,9,8,10',
      '2026-01-20,11,9,10',
      '16/01/2026,11,9,10',
    ].join('\n');
    const r = parseBarsCsv(csv, sessions);
    expect(r.bars).toEqual([]);
    expect(r.errors).toEqual([
      'line 3: 5 cells, the header has 4',
      'line 4: close "abc" is not a number',
      'line 8: date 16/01/2026 is not YYYY-MM-DD',
    ]);
    // Once the rows parse: order, trading days and the structure of each bar.
    const later = parseBarsCsv(
      ['date,high,low,close', '2026-01-19,11,9,10', '2026-01-20,9,8,10', '2026-01-20,11,9,10'].join(
        '\n',
      ),
      sessions,
    );
    expect(later.errors).toEqual([
      '2026-01-20: dates must be in order, each once',
      '2026-01-19: not a trading day',
      '2026-01-20: high below open or close',
    ]);
  });

  it('needs a date and a close column', () => {
    expect(parseBarsCsv('day,price\n', sessions).errors).toContain('line 1: no close column');
  });
});
