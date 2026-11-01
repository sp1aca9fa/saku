// Shared shapes of the statistics (docs/analytics.md "Statistics"): a value or "no value" with a
// reason, as a metric; and the near-tie rule every deciding comparison uses.
import { NO_VALUE_REASONS, TIE } from './metrics';

export const STATISTIC_NO_VALUE_REASONS = [
  ...NO_VALUE_REASONS,
  /** Fewer trials than the statistic compares. */
  'tooFewTrials',
  /** The data does not span the window. */
  'notCovered',
] as const;
export type StatisticReason = (typeof STATISTIC_NO_VALUE_REASONS)[number];

export type Statistic<T> = { ok: true; value: T } | { ok: false; reason: StatisticReason };

/** The statistics shown to users (each has its texts under `statistics.<id>`). */
export const STATISTIC_IDS = [
  'deflatedSharpe',
  'overfittingProbability',
  'effectiveTrials',
  'walkForward',
  'crisisSurvival',
  'goalProbability',
] as const;

export const ok = <T>(v: T): Statistic<T> => ({ ok: true, value: v });
export const noValue = <T>(reason: StatisticReason): Statistic<T> => ({ ok: false, reason });

/** Near tie (relative, the near-tie rule): rounding never flips a decision between implementations. */
export function nearTie(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE * Math.max(Math.abs(a), Math.abs(b));
}
