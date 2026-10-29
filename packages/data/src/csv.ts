// The manual fallback (requirements 04): daily bars from a CSV file, validated before anything is
// stored. Only raw fields are accepted (no adjusted closes or other derived values); one bad row
// refuses the whole file.
import { type RawBar, isTradingDate } from '@saku/core';
import type { Sessions } from './calendar';
import { layerA } from './checks';

/** Accepted columns; `date` and `close` are required, the rest optional. */
export const CSV_COLUMNS = [
  'date',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'dividend',
  'split',
] as const;

export interface CsvResult {
  bars: RawBar[];
  /** Problems with their line numbers (1 = the header); any problem refuses the file. */
  errors: string[];
}

export function parseBarsCsv(text: string, sessions: Sessions): CsvResult {
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) {
    errors.push(
      `line 1: unknown columns ${unknown.join(', ')} (accepted: ${CSV_COLUMNS.join(', ')}; ` +
        'adjusted or derived values are never imported)',
    );
  }
  for (const required of ['date', 'close']) {
    if (!header.includes(required)) errors.push(`line 1: no ${required} column`);
  }
  if (new Set(header).size !== header.length) errors.push('line 1: a column appears twice');
  if (errors.length) return { bars: [], errors };

  const col = (name: string) => header.indexOf(name);
  const bars: RawBar[] = [];
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    if (line.trim() === '') return;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== header.length) {
      errors.push(`line ${n}: ${cells.length} cells, the header has ${header.length}`);
      return;
    }
    const date = cells[col('date')]!;
    if (!isTradingDate(date)) {
      errors.push(`line ${n}: date ${date} is not YYYY-MM-DD`);
      return;
    }
    const num = (name: string, fallback?: number): number | undefined => {
      const at = col(name);
      const cell = at >= 0 ? cells[at]! : '';
      if (cell === '') return fallback;
      // Plain decimal numbers only (no thousands separators, no exponent tricks).
      if (!/^-?\d+(\.\d+)?$/.test(cell)) {
        errors.push(`line ${n}: ${name} "${cell}" is not a number`);
        return fallback;
      }
      return Number(cell);
    };
    if (cells[col('close')] === '') {
      errors.push(`line ${n}: no close`);
      return;
    }
    const close = num('close');
    if (close === undefined) return;
    const open = num('open');
    const high = num('high');
    const low = num('low');
    const volume = num('volume');
    bars.push({
      date,
      ...(open !== undefined && { open }),
      ...(high !== undefined && { high }),
      ...(low !== undefined && { low }),
      close,
      closeIsSplitAdjusted: false,
      ...(volume !== undefined && { volume }),
      divCash: num('dividend', 0)!,
      splitFactor: num('split', 1)!,
    });
  });
  if (errors.length) return { bars: [], errors };

  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.date <= bars[i - 1]!.date) {
      errors.push(`${bars[i]!.date}: dates must be in order, each once`);
    }
  }
  // Layer A's structural checks on every bar (the move and unchanged-close flags are left to
  // the checks after import, where the other sources are compared).
  for (const r of layerA(bars, { source: 'csv', primary: false, leverage: 1, sessions })) {
    if (r.check === 'bar_valid' && r.status !== 'green') errors.push(`${r.date}: ${r.message}`);
  }
  return errors.length ? { bars: [], errors } : { bars, errors };
}
