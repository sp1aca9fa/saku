import { describe, expect, it } from 'vitest';
import { parseJobArgs } from './jobs-args';

describe('parseJobArgs', () => {
  it('reads each job and its known flags', () => {
    expect(parseJobArgs(['weekly'])).toEqual({ job: 'weekly', force: false });
    expect(parseJobArgs(['daily', '--force'])).toEqual({ job: 'daily', force: true });
    expect(parseJobArgs(['spike'])).toEqual({ job: 'spike', force: false });
    expect(parseJobArgs(['spike', '--from', '2026-10-30'])).toEqual({
      job: 'spike',
      force: false,
      from: '2026-10-30',
    });
  });

  it('reads probe --report with --from and --file, in any order', () => {
    expect(parseJobArgs(['probe'])).toEqual({ job: 'probe', force: false });
    expect(parseJobArgs(['probe', '--report'])).toEqual({
      job: 'probe',
      force: false,
      report: true,
    });
    expect(
      parseJobArgs(['probe', '--from', '2026-10-30', '--report', '--file', '/x/p.jsonl']),
    ).toEqual({ job: 'probe', force: false, from: '2026-10-30', report: true, file: '/x/p.jsonl' });
    for (const argv of [
      ['probe', '--from', '2026-10-30'],
      ['probe', '--file', 'x'],
      ['probe', '--report', '--report'],
      ['probe', '--report', '--from', 'soon'],
      ['probe', '--report', '--from', '2026-02-30'],
      ['probe', '--report', '--file'],
      ['probe', '--report', '--bogus'],
    ])
      expect(parseJobArgs(argv), argv.join(' ')).toHaveProperty('error');
  });

  it('refuses an unknown job, an unknown argument and a flag of another job', () => {
    const refused = [
      [],
      ['dialy'],
      ['spike', '--from=2026-10-30'],
      ['spike', '--form', '2026-10-30'],
      ['spike', '2026-10-30'],
      ['spike', '--force'],
      ['daily', '--from', '2026-10-30'],
      ['daily', '--forse'],
      ['weekly', '--force'],
      ['bootstrap', 'extra'],
    ];
    for (const argv of refused) expect(parseJobArgs(argv), argv.join(' ')).toHaveProperty('error');
  });

  it('refuses --from without a value or given twice, and --force given twice', () => {
    expect(parseJobArgs(['spike', '--from'])).toHaveProperty('error');
    expect(parseJobArgs(['spike', '--from', ''])).toHaveProperty('error');
    expect(parseJobArgs(['spike', '--from', '--force'])).toHaveProperty('error');
    expect(parseJobArgs(['spike', '--from', '2026-10-30', '--from', '2026-11-02'])).toHaveProperty(
      'error',
    );
    expect(parseJobArgs(['daily', '--force', '--force'])).toHaveProperty('error');
  });
});
