// The costs a strategy runs with (core `resolveCosts`; requirements 05 "Costs", 09 "Cost model
// before C1"; spec 2026-11-02 c2-settings): its own, and the install's `broker_costs` for each it
// omits. Registration writes the result into the stored version (a later settings change never
// changes a registered version); a draft backtest calls this with the current setting and shows
// `costsLine`, which names the values taken from the install.
//
// Not applied to stored versions: they are read as registered (forward.ts `parseVersion`). One
// registered before C2 with a cost omitted keeps the meaning it was computed with (the backtest
// reads an omitted cost as 0); it is never re-read with the current setting.
import {
  COST_FIELDS,
  type CostField,
  type FullCosts,
  type Strategy,
  resolveCosts,
} from '@saku/core';
import { BROKER_COSTS_EXAMPLE, type Db, brokerCosts } from '@saku/db';

export type EffectiveCosts =
  /** The strategy with every cost stated; `fromInstall`: the fields taken from `broker_costs`. */
  | { strategy: Strategy; fromInstall: CostField[] }
  /** Why the costs are not known (a field omitted and no usable `broker_costs`). */
  | { problem: string };

/** The strategy with its effective costs, or why they are not known. */
export async function effectiveCosts(db: Db, strategy: Strategy): Promise<EffectiveCosts> {
  const omitted = COST_FIELDS.filter((f) => strategy.costs[f] === undefined);
  if (omitted.length === 0) return { strategy, fromInstall: [] };
  const setting = await brokerCosts(db);
  if ('invalid' in setting) {
    return {
      problem:
        `The strategy leaves out costs.${omitted.join(', costs.')} and the install's broker_costs ` +
        `does not parse (${setting.invalid.join('; ')}): set it again with pnpm settings set broker_costs.`,
    };
  }
  // Decimal text with at most 15 significant digits reads into float64 exactly (`parseBrokerCosts`).
  const install =
    'costs' in setting
      ? (Object.fromEntries(COST_FIELDS.map((f) => [f, Number(setting.costs[f])])) as FullCosts)
      : undefined;
  const resolved = resolveCosts(strategy.costs, install);
  if ('missing' in resolved) {
    return {
      problem:
        `The strategy leaves out costs.${resolved.missing.join(', costs.')} and the install has no ` +
        `broker costs set (never read as 0): state them in the file, or ` +
        `pnpm settings set broker_costs '${BROKER_COSTS_EXAMPLE}' with your broker's values.`,
    };
  }
  return { strategy: { ...strategy, costs: resolved.costs }, fromInstall: resolved.fromInstall };
}

/**
 * The FX spread is stored with the version but no backtest charges it yet: backtests are in USD
 * (no conversion to the base currency) until the base-currency layer. Said wherever it is shown.
 */
export const FX_SPREAD_NOT_APPLIED =
  'not applied yet: backtests are in USD until the base-currency layer';

/** The effective costs in one line, naming those taken from the install's settings. */
export function costsLine(e: { strategy: Strategy; fromInstall: CostField[] }): string {
  const c = e.strategy.costs;
  const from =
    e.fromInstall.length > 0
      ? ` (from the install's broker_costs: ${e.fromInstall.join(', ')})`
      : '';
  return (
    `Costs: slippageBps ${c.slippageBps}, feePct ${c.feePct}, fxSpreadPct ${c.fxSpreadPct} ` +
    `(${FX_SPREAD_NOT_APPLIED})${from}`
  );
}
