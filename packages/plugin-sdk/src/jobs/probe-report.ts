// `pnpm probe --report`: the probe file as a short table. Per bar source and date, when the bar
// first appeared and when its values last changed, in New York time and in minutes after that
// date's 16:00 close (negative: before it). Reads a local file, sends nothing.
// An early close (13:00) is not special-cased: the minutes are always from 16:00.
import { readFileSync } from 'node:fs';
import { finalization, type ProbeLine } from './probe';

const TZ = 'America/New_York';
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** The New York wall clock of an instant, as `YYYY-MM-DD HH:MM`. */
function nyClock(ms: number): string {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The instant (ms) of 16:00 New York on a trading date. */
export function closeInstant(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 16, 0);
  // New York is 4 or 5 hours behind UTC; the offset that reads back as 16:00 is the right one.
  for (const hours of [4, 5]) {
    const t = wall + hours * 3_600_000;
    if (nyClock(t) === `${date} 16:00`) return t;
  }
  throw new Error(`No 16:00 New York close for ${date}.`);
}

/** A real calendar date `YYYY-MM-DD` (2026-02-30 is not). */
export function isRealDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

/** Reads the probe file: the lines that parse, and how many lines did not. */
export function readProbeFile(file: string): { lines: ProbeLine[]; unreadable: number } {
  const lines: ProbeLine[] = [];
  let unreadable = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const l = JSON.parse(raw) as ProbeLine;
      const ok =
        typeof l.at === 'string' &&
        !Number.isNaN(Date.parse(l.at)) &&
        typeof l.source === 'string' &&
        (l.date === undefined || (typeof l.date === 'string' && isRealDate(l.date)));
      if (ok) lines.push(l);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { lines, unreadable };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

export function probeReport(o: { lines: ProbeLine[]; unreadable: number; from?: string }): string {
  const out: string[] = [];
  out.push(
    'Probe report. Times are probe times (the hourly check), at most one hour late; New York time;',
    '"after close" is minutes after that date\'s 16:00 New York close, also on early-close days (13:00).',
  );
  const lines = o.lines.filter((l) => (o.from ? (l.date ?? l.at.slice(0, 10)) >= o.from : true));
  if (o.unreadable > 0)
    out.push(`Unreadable lines in the file (not counted below): ${o.unreadable}.`);
  const sources = [...new Set(lines.map((l) => l.source))].sort();
  if (sources.length === 0) out.push('No probe lines.');
  for (const source of sources) {
    const mine = lines.filter((l) => l.source === source);
    const bars = mine.filter((l) => l.date).sort((a, b) => a.at.localeCompare(b.at));
    const latest = bars.reduce((m, l) => (l.at > m ? l.at : m), '');
    const rows = finalization(bars).sort((a, b) => a.date.localeCompare(b.date));
    out.push('', `Source ${source}`);
    const lastProbe = mine.reduce((m, l) => (l.at > m.at ? l : m));
    const lastAt = Date.parse(lastProbe.at);
    const lastOk = mine.some((l) => l.at === lastProbe.at && l.date);
    out.push(
      `last probe: ${nyClock(lastAt)}, ` +
        (lastOk
          ? 'ok'
          : `error: ${mine.find((l) => l.at === lastProbe.at && l.error)?.error ?? 'unknown'}`),
    );
    out.push('date        first seen (NY)   after close  last change (NY)  after close  changes');
    const settled: number[] = [];
    let open = 0;
    for (const r of rows) {
      const close = closeInstant(r.date);
      const first = Date.parse(r.first);
      const change = Date.parse(r.lastChange);
      const still = r.lastChange === latest;
      if (still) open++;
      else settled.push(Math.round((change - close) / 60_000));
      out.push(
        [
          r.date,
          nyClock(first).padEnd(17),
          String(Math.round((first - close) / 60_000)).padStart(11),
          nyClock(change).padEnd(17),
          String(Math.round((change - close) / 60_000)).padStart(11),
          String(r.changes).padStart(7),
          still ? '  may still change' : '',
        ].join('  '),
      );
    }
    const errors = mine.filter((l) => l.error);
    const counts = new Map<string, number>();
    for (const e of errors) counts.set(e.error!, (counts.get(e.error!) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.push(
      `Summary ${source}: dates seen ${rows.length}; last change after close: ` +
        (settled.length > 0
          ? `median ${median(settled)} min, maximum ${Math.max(...settled)} min`
          : 'no settled dates') +
        ` (${open} left out, may still change); error lines ${errors.length}` +
        (top ? `, most frequent: ${top[0]} (${top[1]}x)` : '') +
        '.',
    );
  }
  return out.join('\n');
}
