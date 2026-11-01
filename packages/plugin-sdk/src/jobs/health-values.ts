// The values behind non-green check results (spec 2026-11-01 health-values; requirements 04,
// verification layers A-C and the data-health report; stage A1 "every failure explained", A3
// data-health CLI report): for a check result, the inputs that check compared, read from the
// database as stored now, so a failure can be explained from one pasted output. Read-only.
//
// - As stored now, never as the run saw them: raw bars, FX rates and series values can be revised
//   after the run (bar revisions are listed; series and FX vintages are counted), and the source
//   roles, a fund's underlying and its index are read as set now. The check result line carries
//   what the run itself computed (observed, expected, tolerance).
// - The inputs are read the way verify.ts feeds the checks: each source's stored raw bars up to the
//   run's target (`rawBars`), un-split (`unsplit`) for the comparisons; the primary is the bars
//   primary of `source_roles`. The returns, differences, tolerances and statuses come from the
//   checks themselves (`adjReturnCheck`, `leverageCheck`, `indexCheck` of checks.ts, run on the
//   same arrays verify gives them), never from a copy of their math, so the view cannot drift from
//   what the checks compare. Series and FX values are read through `PointInTime` at `now`
//   (withdrawals and restatements applied, as `asOf` does), on the exact date: a value the source
//   no longer has reads `-`. A result naming another source than the one read now says so.
// - Unknown stays unknown: a missing value prints `-` (never 0); a comparison the stored data no
//   longer allows says so instead of a number. A check this file does not know shows its result
//   line only (no guessed inputs).
import {
  type CheckLayer,
  type FxKind,
  type RawBar,
  type TradingDate,
  totalReturn,
} from '@saku/core';
import { type CheckResult, adjReturnCheck, indexCheck, leverageCheck, unsplit } from '@saku/data';
import { type Db, fxPointInTime, schema, seriesPointInTime } from '@saku/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DateRow } from './health-summary';
import { rawBars, roles } from './verify';

/** Dates per group by default, and the most `--per-group` takes. */
export const PER_GROUP_DEFAULT = 5;
export const PER_GROUP_MAX = 50;
/** With `--values`, a `--check` listing shows at most this many results. */
export const VALUES_CAP = 50;

/**
 * Up to `n` items spread evenly over `items` (ascending dates), the first and the last always
 * included; all of them when there are no more than `n`. With `n` 1, the first (where the group
 * starts).
 */
export function sampleDates<T>(items: T[], n: number): T[] {
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`Sample size ${n} is not a whole number >= 1.`);
  if (items.length <= n) return [...items];
  if (n === 1) return [items[0]!];
  const out: T[] = [];
  // Index i * (len - 1) / (n - 1), rounded: 0 and len - 1 at the ends; the step is above 1 when
  // len > n, so no index repeats.
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

/**
 * A number for the pasted output: up to 10 significant digits without float noise (1.23, not
 * 1.2300000000000002); `-` for a missing value (never 0); non-finite values as they are.
 */
export function fmt(x: number | null | undefined): string {
  if (x === null || x === undefined) return '-';
  if (!Number.isFinite(x)) return String(x);
  return String(Number(x.toPrecision(10)));
}

/**
 * Rows as columns padded to their widest cell; the last cell of a row is not padded, and a short
 * row's last cell ("no bar") does not widen its column.
 */
export function table(rows: string[][], indent = ''): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: width }, (_, i) =>
    Math.max(...rows.map((r) => (i < r.length - 1 ? r[i]!.length : 0))),
  );
  return rows.map(
    (r) =>
      indent +
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
  );
}

/** One check result as a line: status, observed, expected, tolerance, message. */
export function resultLine(r: DateRow, o: { full?: boolean } = {}): string {
  const who = o.full ? [r.layer, r.check, r.symbol, r.source ?? '-'] : [];
  return [
    r.date,
    r.status,
    ...who,
    `observed ${fmt(r.observed)}`,
    `expected ${fmt(r.expected)}`,
    `tolerance ${fmt(r.tolerance)}`,
    r.message ?? '-',
  ].join('  ');
}

/** What a check compares, by its layer and name (verify.ts); `other`: not known here. */
export type Family = 'bars' | 'adj_return' | 'leverage' | 'index' | 'fx' | 'other';

const BAR_CHECKS: Partial<Record<CheckLayer, string[]>> = {
  A: ['bar_valid', 'large_move', 'unchanged_close', 'missing_day'],
  B: ['close_match', 'dividend_match', 'dividend_pending', 'split_match', 'secondary_missing'],
};

export function family(r: { layer: CheckLayer; check: string; symbolId: number | null }): Family {
  if (r.symbolId === null) {
    return r.layer === 'B' && ['fx_match', 'fx_unavailable'].includes(r.check) ? 'fx' : 'other';
  }
  if (BAR_CHECKS[r.layer]?.includes(r.check)) return 'bars';
  if (r.layer === 'B' && r.check === 'adj_return_match') return 'adj_return';
  if (r.layer === 'C' && r.check === 'leverage_track') return 'leverage';
  if (r.layer === 'C' && ['index_match', 'index_unavailable'].includes(r.check)) return 'index';
  return 'other';
}

interface SymbolRow {
  id: number;
  ticker: string;
  leverageFactor: number;
  underlyingSymbolId: number | null;
  indexSeries: string | null;
}

interface Bars {
  /** Raw bars by source as stored, up to the run's target, sorted. */
  raw: Map<string, RawBar[]>;
  /** The same, un-split as the comparisons read them. */
  compared: Map<string, RawBar[]>;
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no');
const byDate = (list: RawBar[] | undefined, date: TradingDate) =>
  list?.find((b) => b.date === date);
/** The last bar dated before `date` in a sorted list. */
const before = (list: RawBar[] | undefined, date: TradingDate) => {
  let out: RawBar | undefined;
  for (const b of list ?? []) {
    if (b.date >= date) break;
    out = b;
  }
  return out;
};

/** A check's result for `date` recomputed now, with the results before it (in the check's order). */
function onDate(results: CheckResult[], date: TradingDate) {
  const k = results.findIndex((x) => x.date === date);
  return k < 0 ? undefined : { result: results[k]!, earlier: results.slice(0, k) };
}

/** `difference D; tolerance T; status S (message)` of a result recomputed now. */
const graded = (c: CheckResult) =>
  `difference ${fmt(c.deviation)}; tolerance ${fmt(c.tolerance)}; status now ${c.status}` +
  (c.message ? ` (${c.message})` : '');

/**
 * Reads the values behind check results for one run. `to`: the run's target (bars after it are
 * left out, as verify left them out); `now`: when the series and FX values are read.
 */
export class ValuesReader {
  private readonly symbols = new Map<number, SymbolRow | undefined>();
  private readonly bars = new Map<number, Bars>();
  private readonly series = new Map<string, Awaited<ReturnType<typeof seriesPointInTime>>>();
  private readonly fx = new Map<string, Awaited<ReturnType<typeof fxPointInTime>>>();
  private barRoles?: Awaited<ReturnType<typeof roles>>;
  private seriesRoles?: Awaited<ReturnType<typeof roles>>;
  private fxRoles?: Awaited<ReturnType<typeof roles>>;

  constructor(
    private readonly db: Db,
    private readonly o: { runId: string; to?: TradingDate; now: string },
  ) {}

  /** The value lines for one check result (indented), none for a check not known here. */
  async lines(r: DateRow): Promise<string[]> {
    switch (family(r)) {
      case 'bars':
        return this.barLines(r);
      case 'adj_return':
        return this.adjReturnLines(r);
      case 'leverage':
        return this.leverageLines(r);
      case 'index':
        return this.indexLines(r);
      case 'fx':
        return this.fxLines(r);
      default:
        return [];
    }
  }

  private async symbol(id: number): Promise<SymbolRow | undefined> {
    if (!this.symbols.has(id)) {
      const [row] = await this.db
        .select({
          id: schema.symbols.id,
          ticker: schema.symbols.ticker,
          leverageFactor: schema.symbols.leverageFactor,
          underlyingSymbolId: schema.symbols.underlyingSymbolId,
          indexSeries: schema.symbols.indexSeries,
        })
        .from(schema.symbols)
        .where(eq(schema.symbols.id, id));
      this.symbols.set(id, row);
    }
    return this.symbols.get(id);
  }

  private async barsOf(id: number): Promise<Bars> {
    let b = this.bars.get(id);
    if (!b) {
      const raw = new Map<string, RawBar[]>();
      const compared = new Map<string, RawBar[]>();
      for (const [source, list] of await rawBars(this.db, id)) {
        const mine = list.filter((x) => this.o.to === undefined || x.date <= this.o.to);
        raw.set(source, mine);
        compared.set(source, unsplit(mine));
      }
      b = { raw, compared };
      this.bars.set(id, b);
    }
    return b;
  }

  private async primary(): Promise<string | undefined> {
    this.barRoles ??= await roles(this.db, 'bars');
    return this.barRoles.primary;
  }

  /** The primary's bar before `date` (the previous date every bar check compares with). */
  private async primaryPrev(id: number, date: TradingDate): Promise<TradingDate | undefined> {
    const p = await this.primary();
    return p ? before((await this.barsOf(id)).compared.get(p), date)?.date : undefined;
  }

  private async barLines(r: DateRow): Promise<string[]> {
    const id = r.symbolId!;
    const dates = new Set([r.date]);
    const prev = await this.primaryPrev(id, r.date);
    if (prev) dates.add(prev);
    // Layer A compares a source with its own previous bar.
    if (r.layer === 'A' && r.source !== null) {
      const own = before((await this.barsOf(id)).raw.get(r.source), r.date)?.date;
      if (own) dates.add(own);
    }
    const shown = [...dates].sort();
    return [
      ...(await this.rawTable(id, shown)),
      ...(await this.canonicalTable(id, shown)),
      ...(await this.revisionTable([id], shown)),
    ];
  }

  /** Every source's raw bar on each date (primary first), and the values as compared. */
  private async rawTable(id: number, dates: TradingDate[]): Promise<string[]> {
    const { raw, compared } = await this.barsOf(id);
    const p = await this.primary();
    this.barRoles ??= await roles(this.db, 'bars');
    const named = [this.barRoles.primary, ...this.barRoles.secondaries, ...this.barRoles.checks];
    const sources = [...new Set([...named.filter((s): s is string => !!s), ...raw.keys()])].sort(
      (a, b) => (a === p ? -1 : b === p ? 1 : a < b ? -1 : a > b ? 1 : 0),
    );
    const rows = [
      [
        'raw',
        'date',
        'source',
        'close',
        'split-adj',
        'split',
        'div',
        'provider adj',
        'compared close',
        'compared div',
      ],
    ];
    for (const date of dates) {
      for (const source of sources) {
        const b = byDate(raw.get(source), date);
        const c = byDate(compared.get(source), date);
        const who = source === p ? `${source} (primary)` : source;
        if (!b) {
          rows.push(['', date, who, 'no bar']);
          continue;
        }
        rows.push([
          '',
          date,
          who,
          fmt(b.close),
          yesNo(b.closeIsSplitAdjusted),
          fmt(b.splitFactor),
          fmt(b.divCash),
          fmt(b.providerAdjClose),
          fmt(c?.close),
          fmt(c?.divCash),
        ]);
      }
    }
    return table(rows, '  ');
  }

  /** The canonical bars (ours) on each date. */
  private async canonicalTable(id: number, dates: TradingDate[]): Promise<string[]> {
    const b = schema.bars;
    const stored = await this.db
      .select()
      .from(b)
      .where(and(eq(b.symbolId, id), inArray(b.date, dates)));
    const rows = [
      ['canonical', 'date', 'close', 'split', 'div', 'adjClose', 'source', 'stand-in', 'status'],
    ];
    for (const date of dates) {
      const x = stored.find((s) => s.date === date);
      if (!x) {
        rows.push(['', date, 'no canonical bar']);
        continue;
      }
      rows.push([
        '',
        date,
        fmt(x.close),
        fmt(x.splitFactor),
        fmt(x.divCash),
        fmt(x.adjClose),
        x.source,
        yesNo(x.standIn),
        x.status ?? '-',
      ]);
    }
    return table(rows, '  ');
  }

  /** Revisions of the symbols' raw bars on the dates (values changed since they were stored). */
  private async revisionTable(ids: number[], dates: TradingDate[]): Promise<string[]> {
    const v = schema.barRevisions;
    const rows = await this.db
      .select()
      .from(v)
      .where(and(inArray(v.symbolId, ids), inArray(v.date, dates)))
      .orderBy(asc(v.date), asc(v.symbolId), asc(v.detectedAt), asc(v.source), asc(v.field));
    if (rows.length === 0) return [];
    const many = ids.length > 1;
    const tickers = new Map<number, string>();
    for (const id of ids) tickers.set(id, (await this.symbol(id))?.ticker ?? `#${id}`);
    return table(
      [
        [
          'revised',
          'date',
          ...(many ? ['symbol'] : []),
          'source',
          'field',
          'old',
          'new',
          'detected',
        ],
        ...rows.map((x) => [
          '',
          x.date,
          ...(many ? [tickers.get(x.symbolId)!] : []),
          x.source,
          x.field,
          fmt(x.oldValue),
          fmt(x.newValue),
          x.detectedAt,
        ]),
      ],
      '  ',
    );
  }

  /**
   * adj_return_match: `adjReturnCheck` run now on what verify gives it (the un-split bars primary,
   * the result's source un-split), its result for the date: our total-return index's return
   * (the result's expected) against the provider's adjusted closes' return (its observed) over the
   * primary's previous date and the date.
   */
  private async adjReturnLines(r: DateRow): Promise<string[]> {
    const id = r.symbolId!;
    const out = await this.barLines(r);
    const p = await this.primary();
    const { compared } = await this.barsOf(id);
    const primary = p ? (compared.get(p) ?? []) : [];
    const provider = r.source === null ? undefined : compared.get(r.source);
    const now =
      p && r.source !== null && provider
        ? onDate(adjReturnCheck(primary, provider, r.source), r.date)?.result
        : undefined;
    if (!p) out.push('  no bars primary is set now');
    if (!now) {
      out.push(
        `  returns: not comparable now (no result for ${r.date}: the primary lacks the date or ` +
          'the bar before it, or the provider an adjusted close on either)',
      );
      return out;
    }
    const prev = before(primary, r.date)!.date;
    out.push(
      `  returns ${prev} to ${r.date}: ours ${fmt(now.expected)}; ${r.source} adjusted ` +
        `${fmt(byDate(provider, prev)?.providerAdjClose)} to ` +
        `${fmt(byDate(provider, r.date)?.providerAdjClose)}, return ${fmt(now.observed)}; ` +
        graded(now),
    );
    return out;
  }

  /**
   * leverage_track: `leverageCheck` run now on what verify gives it (the fund's and its
   * underlying's un-split bars primary, the leverage set now), its result for the date: the
   * fund's total return against the leverage times the underlying's total return, the tolerance
   * and the status, the three-days-in-a-row rule included (the whole history up to the run's
   * target is passed, as verify passes it). For a streak, the earlier days of the streak too. A
   * result stored before the check compared total returns (spec 2026-11-01 layer-c-dividends)
   * carries the underlying's price return in its expected value; the line below reads as the
   * check does now.
   */
  private async leverageLines(r: DateRow): Promise<string[]> {
    const id = r.symbolId!;
    const s = await this.symbol(id);
    const p = await this.primary();
    if (!p) return ['  no bars primary is set now'];
    const fund = (await this.barsOf(id)).compared.get(p) ?? [];
    const prev = before(fund, r.date)?.date;
    const dates = prev ? [prev, r.date] : [r.date];
    const uid = s?.underlyingSymbolId ?? null;
    const under = uid === null ? [] : ((await this.barsOf(uid)).compared.get(p) ?? []);
    const uTicker = uid === null ? undefined : ((await this.symbol(uid))?.ticker ?? `#${uid}`);
    const rows = [['compared', 'symbol', 'date', 'close', 'split', 'div']];
    for (const [ticker, list] of [
      [s?.ticker ?? `#${id}`, fund],
      ...(uTicker ? [[uTicker, under] as const] : []),
    ] as const) {
      for (const date of dates) {
        const b = byDate(list, date);
        rows.push(
          b
            ? ['', ticker, date, fmt(b.close), fmt(b.splitFactor), fmt(b.divCash)]
            : ['', ticker, date, 'no bar'],
        );
      }
    }
    const out = table(rows, '  ');
    if (uid === null) out.push('  no underlying is set now');
    const day =
      s && uid !== null ? onDate(leverageCheck(fund, under, s.leverageFactor), r.date) : undefined;
    if (!day) {
      out.push(
        '  returns: not comparable now (the fund and its underlying lack the same two dates)',
      );
    } else {
      const c = day.result;
      const ua = before(under, r.date);
      const ub = byDate(under, r.date);
      out.push(
        `  fund total return ${fmt(c.observed)}; underlying total return ` +
          `${fmt(ua && ub ? totalReturn(ua, ub) : undefined)}; leverage ${fmt(s!.leverageFactor)}; ` +
          `expected ${fmt(c.expected)}; ${graded(c)}`,
      );
      // A streak (the stored result's message or the check's now): the two days before it, the
      // rule's three in a row (04 layer C).
      if (/in a row/.test(r.message ?? '') || /in a row/.test(c.message ?? '')) {
        const earlier = day.earlier.slice(-2);
        out.push(
          earlier.length > 0
            ? `  streak, the days before as compared now: ${earlier
                .map(
                  (x) =>
                    `${x.date} difference ${fmt(x.deviation)}, tolerance ${fmt(x.tolerance)}, ${x.status}`,
                )
                .join('; ')}`
            : '  streak: no earlier day compared now',
        );
      }
    }
    out.push(...(await this.revisionTable(uid === null ? [id] : [id, uid], dates)));
    return out;
  }

  /**
   * A line when an index result names another series source than the series primary this view
   * reads now (the roles changed since the run). The run stores no source for index_match when it
   * had no series primary, and `none` for index_unavailable.
   */
  private otherSeriesSource(r: DateRow, now: string | undefined): string[] {
    const named = r.source === null || r.source === 'none' ? undefined : r.source;
    if (named === now) return [];
    return [
      `  the run compared ${named ?? 'no series source'}; read here: ${now ?? 'none'} ` +
        '(the series primary now)',
    ];
  }

  private async seriesOf(id: string, source: string) {
    const key = JSON.stringify([id, source]);
    let pit = this.series.get(key);
    if (!pit) {
      pit = await seriesPointInTime(this.db, id, source);
      this.series.set(key, pit);
    }
    return pit;
  }

  /**
   * index_match / index_unavailable: `indexCheck` run now on what verify gives it (the fund's
   * un-split bars primary, the series primary's values known at `now`, the run's target), its
   * result for the date: the fund's total return against the index's return over the same two
   * dates (every source's values shown). A result stored before the check compared total
   * returns (spec 2026-11-01 layer-c-dividends) carries the fund's price return as observed; the
   * line below reads as the check does now.
   */
  private async indexLines(r: DateRow): Promise<string[]> {
    const id = r.symbolId!;
    const s = await this.symbol(id);
    const p = await this.primary();
    const fund = p ? ((await this.barsOf(id)).compared.get(p) ?? []) : [];
    const prev = before(fund, r.date)?.date;
    const dates = prev ? [prev, r.date] : [r.date];
    const rows = [['compared', 'date', 'close', 'split', 'div']];
    for (const date of dates) {
      const b = byDate(fund, date);
      rows.push(
        b
          ? ['', date, fmt(b.close), fmt(b.splitFactor), fmt(b.divCash)]
          : ['', date, p ? 'no bar' : 'no bars primary is set now'],
      );
    }
    const out = table(rows, '  ');
    const series = s?.indexSeries;
    if (!series) {
      out.push('  no index series is set now');
      return [...out, ...(await this.revisionTable([id], dates))];
    }
    this.seriesRoles ??= await roles(this.db, 'series');
    const sp = this.seriesRoles.primary;
    const sources = await this.sourcesOf('series', series, [
      sp,
      ...this.seriesRoles.secondaries,
      ...this.seriesRoles.checks,
    ]);
    const vrows = [['index', 'date', 'source', 'value', 'known_at', 'published_at', 'vintages']];
    for (const date of dates) {
      for (const source of sources) {
        vrows.push([
          '',
          date,
          source === sp ? `${source} (primary)` : source,
          ...(await this.vintageCells('series', series, source, date)),
        ]);
      }
    }
    out.push(`  index series ${series}, as read now:`);
    out.push(...table(vrows, '  '));
    out.push(...this.otherSeriesSource(r, sp));
    if (!sp) out.push('  no series primary is set now');
    else out.push(await this.indexReturns(fund, series, sp, r.date, prev));
    out.push(...(await this.revisionTable([id], dates)));
    return out;
  }

  /** The line of `indexCheck`'s result for `date`, recomputed now. */
  private async indexReturns(
    fund: RawBar[],
    series: string,
    sp: string,
    date: TradingDate,
    prev: TradingDate | undefined,
  ): Promise<string> {
    let index: { date: TradingDate; value: number }[];
    try {
      index = (await this.seriesOf(series, sp)).knownAt(this.o.now);
    } catch (e) {
      // A stored history PointInTime refuses: no index return (never a guess).
      return `  returns: not comparable now (${sp} is not readable: ${e instanceof Error ? e.message : String(e)})`;
    }
    if (index.length === 0) return `  returns: not comparable now (no ${sp} value as read now)`;
    const c = onDate(
      indexCheck(fund, index, { source: sp, ...(this.o.to !== undefined && { to: this.o.to }) }),
      date,
    )?.result;
    if (!c) {
      return (
        `  returns: not compared now (no result for ${date}: no fund bar on it or before it, the ` +
        "bar before is older than the index's first value, or the run's date waits for that " +
        "day's value)"
      );
    }
    if (c.check !== 'index_match') {
      return `  index return (${sp}) ${prev ?? '-'} to ${date}: ${c.message ?? c.check} as read now; status now ${c.status}`;
    }
    return (
      `  fund total return ${fmt(c.observed)}; index return (${sp}) ${fmt(c.expected)}; ` +
      graded(c)
    );
  }

  /** The sources with a role, then those with stored rows of the series or pair, sorted. */
  private async sourcesOf(
    kind: 'series' | 'fx',
    item: string,
    named: (string | undefined)[],
  ): Promise<string[]> {
    const rows =
      kind === 'series'
        ? [
            ...(await this.db
              .selectDistinct({ source: schema.series.source })
              .from(schema.series)
              .where(eq(schema.series.series, item))),
            ...(await this.db
              .selectDistinct({ source: schema.seriesWithdrawals.source })
              .from(schema.seriesWithdrawals)
              .where(eq(schema.seriesWithdrawals.series, item))),
          ]
        : [
            ...(await this.db
              .selectDistinct({ source: schema.fxRates.source })
              .from(schema.fxRates)
              .where(eq(schema.fxRates.pair, item))),
            ...(await this.db
              .selectDistinct({ source: schema.fxWithdrawals.source })
              .from(schema.fxWithdrawals)
              .where(eq(schema.fxWithdrawals.pair, item))),
          ];
    const first = named.filter((s): s is string => !!s);
    const rest = rows
      .map((x) => x.source)
      .filter((s) => !first.includes(s))
      .sort();
    return [...new Set([...first, ...rest])];
  }

  /**
   * A series or FX rate on one date from one source, as read now: value, known_at,
   * published_at of the version that holds, and how many versions (values and withdrawals) are
   * stored for the date. No value now: `-`, with `withdrawn` when a withdrawal is stored.
   */
  private async vintageCells(
    kind: 'series' | 'fx',
    item: string,
    source: string,
    date: TradingDate,
    fxKind?: FxKind,
  ): Promise<string[]> {
    const stored =
      kind === 'series'
        ? {
            values: await this.db
              .select({
                value: schema.series.value,
                publishedAt: schema.series.publishedAt,
                knownAt: schema.series.knownAt,
                fetchedAt: schema.series.fetchedAt,
              })
              .from(schema.series)
              .where(
                and(
                  eq(schema.series.series, item),
                  eq(schema.series.source, source),
                  eq(schema.series.date, date),
                ),
              ),
            withdrawals: await this.db
              .select({ knownAt: schema.seriesWithdrawals.knownAt })
              .from(schema.seriesWithdrawals)
              .where(
                and(
                  eq(schema.seriesWithdrawals.series, item),
                  eq(schema.seriesWithdrawals.source, source),
                  eq(schema.seriesWithdrawals.date, date),
                ),
              ),
          }
        : {
            values: await this.db
              .select({
                value: schema.fxRates.rate,
                publishedAt: schema.fxRates.publishedAt,
                knownAt: schema.fxRates.knownAt,
                fetchedAt: schema.fxRates.fetchedAt,
              })
              .from(schema.fxRates)
              .where(
                and(
                  eq(schema.fxRates.pair, item),
                  eq(schema.fxRates.source, source),
                  eq(schema.fxRates.kind, fxKind!),
                  eq(schema.fxRates.date, date),
                ),
              ),
            withdrawals: await this.db
              .select({ knownAt: schema.fxWithdrawals.knownAt })
              .from(schema.fxWithdrawals)
              .where(
                and(
                  eq(schema.fxWithdrawals.pair, item),
                  eq(schema.fxWithdrawals.source, source),
                  eq(schema.fxWithdrawals.kind, fxKind!),
                  eq(schema.fxWithdrawals.date, date),
                ),
              ),
          };
    const vintages = String(stored.values.length + stored.withdrawals.length);
    if (vintages === '0') return ['none stored'];
    let v: { value: number; knownAt: string } | undefined;
    try {
      const pit =
        kind === 'series'
          ? await this.seriesOf(item, source)
          : await this.fxOf(item, source, fxKind!);
      const read = pit.asOf(date, this.o.now);
      v = read && read.date === date ? read : undefined;
    } catch (e) {
      // A stored history PointInTime refuses is reported, never read as a value.
      return [`not readable (${e instanceof Error ? e.message : String(e)})`, '', '', vintages];
    }
    if (!v) {
      return [stored.withdrawals.length > 0 ? '- (withdrawn)' : '-', '-', '-', vintages];
    }
    // The stored row that holds: same value, known from its known_at or (a restatement) its fetch.
    // A date-only known_at is read as an instant, so it may match neither: then the published_at
    // of the rows with that value when they all agree, else unknown ('-'), never a guess.
    const same = stored.values.filter((x) => x.value === v.value);
    const exact = same
      .filter((x) => x.knownAt === v.knownAt || x.fetchedAt === v.knownAt)
      .sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : 1))
      .at(-1);
    const published = exact
      ? exact.publishedAt
      : new Set(same.map((x) => x.publishedAt)).size === 1
        ? same[0]!.publishedAt
        : null;
    return [fmt(v.value), v.knownAt, published ?? '-', vintages];
  }

  private async fxOf(pair: string, source: string, kind: FxKind) {
    const key = JSON.stringify([pair, source, kind]);
    let pit = this.fx.get(key);
    if (!pit) {
      pit = await fxPointInTime(this.db, pair, source, kind);
      this.fx.set(key, pit);
    }
    return pit;
  }

  /**
   * fx_match / fx_unavailable (checks.ts `fxCheck`): every stored rate on the date, per pair,
   * source and kind; the header says which kind the run compared (valuation). The pair is read
   * from the run's overall health row of the date (`<pair>:B.<check>@<source>`, verify.ts);
   * without one, every pair stored that day.
   */
  private async fxLines(r: DateRow): Promise<string[]> {
    // The run's overall row of the date (no symbol).
    const overall = await this.db
      .select({ reasons: schema.dataHealth.reasons })
      .from(schema.dataHealth)
      .where(
        and(
          eq(schema.dataHealth.runId, this.o.runId),
          eq(schema.dataHealth.date, r.date),
          isNull(schema.dataHealth.symbolId),
        ),
      );
    const named = new Set<string>();
    for (const h of overall) {
      for (const code of h.reasons) {
        const m = /^([^:@\s]+):B\.(\w+)@(.+)$/.exec(code);
        if (m && m[2] === r.check && m[3] === r.source) named.add(m[1]!);
      }
    }
    const stored = [
      ...(await this.db
        .selectDistinct({ pair: schema.fxRates.pair, kind: schema.fxRates.kind })
        .from(schema.fxRates)
        .where(eq(schema.fxRates.date, r.date))),
      ...(await this.db
        .selectDistinct({ pair: schema.fxWithdrawals.pair, kind: schema.fxWithdrawals.kind })
        .from(schema.fxWithdrawals)
        .where(eq(schema.fxWithdrawals.date, r.date))),
    ];
    const pairs =
      named.size > 0 ? [...named].sort() : [...new Set(stored.map((x) => x.pair))].sort();
    this.fxRoles ??= await roles(this.db, 'fx');
    const fp = this.fxRoles.primary;
    // verify's fxCheck compares only the `valuation` kind (fxPointInTime's default); other kinds
    // are listed for context.
    const out = [
      named.size > 0
        ? `  FX rates on ${r.date}, as read now (the pair from the run's reason; compared: valuation):`
        : `  FX rates on ${r.date}, as read now (every pair stored; the run's reason names none; ` +
          'compared: valuation):',
    ];
    const rows = [
      ['fx', 'pair', 'source', 'kind', 'value', 'known_at', 'published_at', 'vintages'],
    ];
    for (const pair of pairs) {
      const kinds = [...new Set(stored.filter((x) => x.pair === pair).map((x) => x.kind))].sort();
      const sources = await this.sourcesOf('fx', pair, [
        fp,
        ...this.fxRoles.secondaries,
        ...this.fxRoles.checks,
      ]);
      for (const source of sources) {
        const who = source === fp ? `${source} (primary)` : source;
        // A source with no rate of any kind on the date is listed once, so a missing primary
        // rate (fx_unavailable) shows.
        const found: string[][] = [];
        for (const kind of kinds) {
          const cells = await this.vintageCells('fx', pair, source, r.date, kind);
          if (cells[0] !== 'none stored') found.push(['', pair, who, kind, ...cells]);
        }
        rows.push(...(found.length > 0 ? found : [['', pair, who, '-', 'none stored']]));
      }
    }
    if (pairs.length === 0) out.push('  no FX rate is stored for the date');
    else out.push(...table(rows, '  '));
    return out;
  }
}
