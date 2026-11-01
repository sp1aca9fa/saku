// A strategy's effective costs (requirements 05 "Strategies": "Costs: slippage (bps), fees and FX
// spread, defaulting to the install's broker cost settings (C2)"; 09 "Cost model before C1"; spec
// 2026-11-02 c2-settings).
//
// The rule: each cost the strategy states is its own; each it leaves out is the install's
// (`broker_costs`, an admin setting). A cost neither states is missing: the caller refuses with
// the fields named, never reads it as 0 (Pillar 1: an unstated cost is unknown, not free).
// Registration writes the effective costs into the stored version, so a later change of the
// setting never changes a registered version's results (registered versions are immutable).
import type { Strategy } from './schema';

export const COST_FIELDS = ['slippageBps', 'feePct', 'fxSpreadPct'] as const;
export type CostField = (typeof COST_FIELDS)[number];
/** Every cost stated: slippage in basis points, fee and FX spread in percent of the amount traded. */
export type FullCosts = Record<CostField, number>;

export type CostsResolution =
  /** `fromInstall`: the fields taken from the install's settings, in COST_FIELDS order. */
  | { costs: FullCosts; fromInstall: CostField[] }
  /** The fields neither the strategy nor the install states, in COST_FIELDS order. */
  | { missing: CostField[] };

/**
 * The strategy's costs with each omitted field taken from `install` (undefined: the install has
 * no broker costs set). Missing when a field is omitted and the install has none.
 */
export function resolveCosts(
  own: Strategy['costs'],
  install: FullCosts | undefined,
): CostsResolution {
  const omitted = COST_FIELDS.filter((f) => own[f] === undefined);
  if (omitted.length > 0 && install === undefined) return { missing: omitted };
  const costs = {} as FullCosts;
  for (const f of COST_FIELDS) costs[f] = own[f] ?? install![f];
  return { costs, fromInstall: omitted };
}
