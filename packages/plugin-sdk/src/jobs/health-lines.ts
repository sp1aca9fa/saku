// The lines `pnpm health` prints for one date (jobs/health.ts `healthReport`), shared with the
// monthly audit report (jobs/audit.ts) so both say a day's grade and reasons the same way.
import type { Translate } from '@saku/content';
import { describeReasons } from './alerts';
import type { DayReport, Grade } from './health';

/** A grade in words: "not graded", the status alone, or the status and its reasons. */
export function describeGrade(t: Translate, g: Grade): string {
  if (g.status === 'not_graded') return 'not graded';
  return g.reasons.length ? `${g.status}: ${describeReasons(t, g.reasons)}` : g.status;
}

/** One date: its overall grade (and the run it is from), then each symbol not green. */
export function describeDay(t: Translate, d: DayReport): string[] {
  const by = d.run ? `  (${d.run.jobType} run for ${d.run.target})` : '';
  if (d.green) return [`${d.date}  green${by}`];
  return [
    `${d.date}  ${describeGrade(t, d.overall)}${by}`,
    ...d.symbols.map((s) => `  ${s.ticker}  ${describeGrade(t, s.grade)}`),
  ];
}
