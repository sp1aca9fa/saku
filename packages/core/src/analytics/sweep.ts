// Parameter sweep driver (requirements 09 "Parameter stability"; docs/analytics.md "Statistics",
// "Parameter sweep"): the variants of a strategy over a grid, in a fixed order, each validated and
// evaluated by the caller; and a variant's neighbors. A variant that fails validation is kept with
// its error (it was tried), never dropped.
import { Strategy } from '../strategy/schema';

export type ParameterPath = readonly (string | number)[];

export interface SweepParameter {
  /** Paths into the strategy that take the parameter's value (each must already exist). */
  paths: readonly ParameterPath[];
  /** The values tried, in order (one step = the previous or next value), without repeats. */
  values: readonly unknown[];
}

export interface SweepVariant {
  /** The value index of each parameter. */
  index: number[];
  values: unknown[];
  /** The validated variant, or why it is not a valid strategy. */
  strategy?: Strategy;
  error?: string;
}

export interface SweepResult<R> extends SweepVariant {
  /** The caller's evaluation; undefined for an invalid variant. */
  result?: R;
}

const describe = (path: ParameterPath) => path.map(String).join('.');

/** The container and key a path ends at; throws when any step does not exist. */
function locate(
  root: unknown,
  path: ParameterPath,
): { parent: Record<string | number, unknown>; key: string | number } {
  if (path.length === 0) throw new Error('sweep: a path is not empty.');
  let node: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const exists = Array.isArray(node)
      ? typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < node.length
      : typeof node === 'object' &&
        node !== null &&
        typeof key === 'string' &&
        Object.hasOwn(node, key);
    if (!exists) throw new Error(`sweep: the strategy has no ${describe(path)}.`);
    if (i === path.length - 1) return { parent: node as Record<string | number, unknown>, key };
    node = (node as Record<string | number, unknown>)[key];
  }
  throw new Error('unreachable');
}

function checkGrid(strategy: Strategy, grid: readonly SweepParameter[]): void {
  for (const p of grid) {
    if (p.paths.length === 0) throw new Error('sweep: a parameter has at least one path.');
    if (p.values.length === 0) throw new Error('sweep: a parameter has at least one value.');
    const seen = new Set(p.values.map((v) => JSON.stringify(v)));
    if (seen.size !== p.values.length) {
      throw new Error(`sweep: ${describe(p.paths[0]!)} lists a value twice.`);
    }
    for (const path of p.paths) locate(strategy, path);
  }
  // Two parameters setting the same place (equal paths, or one inside the other) would let the
  // later one silently win: refused.
  const prefix = (a: ParameterPath, b: ParameterPath) =>
    a.length <= b.length && a.every((k, i) => k === b[i]);
  grid.forEach((p, k) => {
    grid.forEach((q, l) => {
      if (l <= k) return;
      for (const a of p.paths) {
        for (const b of q.paths) {
          if (prefix(a, b) || prefix(b, a)) {
            throw new Error(
              `sweep: ${describe(a)} and ${describe(b)} set the same place in two parameters.`,
            );
          }
        }
      }
    });
  });
}

/**
 * Every variant of the grid: the Cartesian product, first parameter outermost, last varying
 * fastest; each the strategy with its paths set, then validated as a strategy.
 */
export function sweepVariants(strategy: Strategy, grid: readonly SweepParameter[]): SweepVariant[] {
  checkGrid(strategy, grid);
  const out: SweepVariant[] = [];
  const index = grid.map(() => 0);
  for (;;) {
    const values = grid.map((p, k) => p.values[index[k]!]);
    const copy = structuredClone(strategy) as unknown;
    grid.forEach((p, k) => {
      for (const path of p.paths) {
        const { parent, key } = locate(copy, path);
        parent[key] = structuredClone(values[k]);
      }
    });
    const parsed = Strategy.safeParse(copy);
    out.push(
      parsed.success
        ? { index: [...index], values, strategy: parsed.data }
        : {
            index: [...index],
            values,
            error: parsed.error.issues
              .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
              .join('; '),
          },
    );
    let k = grid.length - 1;
    while (k >= 0 && index[k] === grid[k]!.values.length - 1) {
      index[k] = 0;
      k--;
    }
    if (k < 0) return out;
    index[k]!++;
  }
}

/** Runs the caller's evaluation (backtest and metrics) on every valid variant, in variant order. */
export function sweep<R>(
  strategy: Strategy,
  grid: readonly SweepParameter[],
  evaluate: (variant: Strategy, index: readonly number[]) => R,
): SweepResult<R>[] {
  return sweepVariants(strategy, grid).map((v) =>
    v.strategy ? { ...v, result: evaluate(v.strategy, v.index) } : v,
  );
}

/**
 * The grid points one step away in exactly one parameter: by parameter, the previous value
 * before the next.
 */
export function neighbors(index: readonly number[], grid: readonly SweepParameter[]): number[][] {
  if (
    index.length !== grid.length ||
    index.some((v, k) => !Number.isInteger(v) || v < 0 || v >= grid[k]!.values.length)
  ) {
    throw new Error('neighbors: the index is not a point of the grid.');
  }
  const out: number[][] = [];
  index.forEach((v, k) => {
    for (const step of [-1, 1]) {
      const w = v + step;
      if (w < 0 || w >= grid[k]!.values.length) continue;
      const n = [...index];
      n[k] = w;
      out.push(n);
    }
  });
  return out;
}
