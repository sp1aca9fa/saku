// Tax regime plug-ins (requirements 07 "What a regime plug-in declares", 15): checking a
// declaration when the plug-ins load, the regime's texts, and the install's `tax_regime` setting.
// A regime only declares; the tax engine computes. Nothing here does tax arithmetic: amounts and
// rates stay decimal text, only checked for form, range and consistency (no float ever holds one).
import { DECIMAL_TEXT, canonicalJson, compareDecimalText, type Json } from '@saku/core';
import {
  type Db,
  type TaxRegimeDeclaration,
  getSetting,
  setSetting,
  sha256,
  taxRegimeDeclaration,
} from '@saku/db';
import type {
  LossOffset,
  MoneyText,
  LotMethod,
  PurchaseMode,
  RegimeTexts,
  SameDayOrder,
  TaxFxKind,
  TaxRegime,
} from './types';

export const PURCHASE_MODES = ['lump_sum', 'periodic'] as const satisfies readonly PurchaseMode[];
export const LOSS_OFFSETS = ['gains', 'dividends'] as const satisfies readonly LossOffset[];
export const LOT_METHODS = ['moving_average', 'fifo'] as const satisfies readonly LotMethod[];
export const SAME_DAY_ORDERS = [
  'execution',
  'purchases_first',
  'sales_first',
] as const satisfies readonly SameDayOrder[];
export const TAX_FX_KINDS = [
  'tax_mid',
  'tax_buy',
  'tax_sell',
] as const satisfies readonly TaxFxKind[];

export const TRADE_DATES = ['trade_date', 'settlement_date'] as const;
export const FOREIGN_DIVIDEND_BASES = ['gross', 'net_of_withholding'] as const;
export const LOSS_CONDITION_EFFECTS = ['offsets', 'carryforward'] as const;

/**
 * The most placeholders each kind of regime text may receive, filled from the declaration
 * (`regimeTextValues`, so a text never disagrees with a rule). The declaration narrows them to
 * what has a value: an account description gets `annual`, `lifetime` only when the account type
 * declares that limit, `groupAnnual`, `groupLifetime` only when exactly one of its groups declares
 * one, `carryforwardYears` only when the carryforward is a number of years; a loss condition gets
 * `carryforwardYears` only when it applies to the carryforward and that is a number. A key used
 * for two texts may use only what both receive; a text no declaration names receives none.
 * Plain `{name}` only, no other braces.
 */
export const REGIME_TEXT_PLACEHOLDERS = {
  regimeName: [],
  accountName: [],
  /** Of the account type described: its rates and limits, and its loss carryforward. */
  accountDescription: [
    'gainsRate',
    'dividendsRate',
    'annual',
    'lifetime',
    'groupAnnual',
    'groupLifetime',
    'carryforwardYears',
  ],
  /** A loss condition: the account type's carryforward, when it applies to it. */
  lossCondition: ['carryforwardYears'],
  creditCondition: [],
  groupName: [],
  rateName: [],
} as const satisfies Record<string, readonly string[]>;
export type RegimeTextKind = keyof typeof REGIME_TEXT_PLACEHOLDERS;

/** The longest loss carryforward a regime may declare in years (beyond it: `'unlimited'`). */
export const MAX_CARRYFORWARD_YEARS = 100;

/** Plug-in keys (as in the registry) and account type, group and rate keys. */
const KEY = /^[a-z][a-z0-9-]{1,39}$/;
const ITEM_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** A regime's own name for a tax rate (`TTM`). */
const RATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const PLACEHOLDER = /\{(\w+)\}/g;
/** Non-negative, plain notation; one rule with the admin settings (core `decimal-text`). */
const DECIMAL = DECIMAL_TEXT;
export { compareDecimalText };

/** Looks up a dotted key in a text tree: the text, or undefined. */
function lookup(tree: RegimeTexts, key: string): string | undefined {
  let node: string | RegimeTexts | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function leafKeys(tree: RegimeTexts, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : leafKeys(v, `${prefix}${k}.`),
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks one regime's declaration; returns every problem found (empty: valid). Refused:
 * unknown fields (a misspelt optional field would silently drop a rule), keys out of form,
 * amounts and rates that are not decimal text (a number, a sign, an exponent), rates outside 0
 * to 1, limits that are 0 or in another currency than the regime's, an annual limit above the
 * lifetime one, references to account types, groups or rates that are not declared, a missing
 * `taxable` account type (or one that is not taxable), and text keys missing from the English
 * texts (or another language's texts naming keys English lacks).
 */
export function taxRegimeProblems(regime: unknown): string[] {
  const problems: string[] = [];
  const bad = (path: string, what: string) => problems.push(`${path}: ${what}`);
  const fields = (v: unknown, path: string, allowed: string[], required: string[]) => {
    // A missing required object is reported once, by its parent (list items pass `?? null`).
    if (v === undefined) return false;
    if (!isObject(v)) {
      bad(path, 'must be an object');
      return false;
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) bad(path, `unknown field "${k}"`);
    for (const k of required) if (v[k] === undefined) bad(path, `"${k}" is required`);
    return true;
  };
  if (!isObject(regime)) return ['regime: must be an object'];
  fields(regime, 'regime', REGIME_FIELDS, REGIME_REQUIRED);
  const r = regime as Record<string, unknown>;

  // Texts first: every text key below must resolve in English.
  const texts = r.texts;
  let en: RegimeTexts | undefined;
  if (isObject(texts)) {
    for (const [lang, tree] of Object.entries(texts)) {
      if (!LANGUAGE.test(lang)) bad(`texts.${lang}`, 'not a language code');
      const problem = textTreeProblem(tree);
      if (problem) bad(`texts.${lang}`, problem);
    }
    if (isObject(texts.en) && !textTreeProblem(texts.en)) en = texts.en as RegimeTexts;
    else if (texts.en === undefined) bad('texts', 'English texts ("en") are required');
    if (en) {
      for (const [lang, tree] of Object.entries(texts)) {
        if (lang === 'en' || textTreeProblem(tree)) continue;
        const extra = leafKeys(tree as RegimeTexts).filter((k) => lookup(en!, k) === undefined);
        if (extra.length > 0) bad(`texts.${lang}`, `keys not in English: ${extra.join(', ')}`);
      }
    }
  } else if (texts !== undefined) bad('texts', 'must be an object of languages');
  /** Per text key, the placeholders it may use (the intersection over the kinds it serves). */
  const allowedPlaceholders = new Map<string, Set<string>>();
  const textKey = (
    v: unknown,
    path: string,
    kind: RegimeTextKind,
    /** What this use has a value for (default: all of its kind's). */
    has: readonly string[] = REGIME_TEXT_PLACEHOLDERS[kind],
  ) => {
    if (typeof v !== 'string' || v === '') return bad(path, 'must be a text key');
    if (en && lookup(en, v) === undefined) bad(path, `no English text "${v}"`);
    const kindOf: readonly string[] = REGIME_TEXT_PLACEHOLDERS[kind];
    const own = new Set<string>(has.filter((p) => kindOf.includes(p)));
    const before = allowedPlaceholders.get(v);
    allowedPlaceholders.set(v, before ? new Set([...before].filter((p) => own.has(p))) : own);
  };

  // info
  let currency: string | undefined;
  let country: string | undefined;
  if (fields(r.info, 'info', INFO_FIELDS, INFO_FIELDS)) {
    const i = r.info as Record<string, unknown>;
    if (typeof i.key !== 'string' || !KEY.test(i.key)) {
      bad('info.key', 'must be 2-40 of a-z, 0-9 and -, starting with a letter');
    }
    if (i.kind !== 'tax_regime') bad('info.kind', 'must be "tax_regime"');
    if (i.version !== undefined && (typeof i.version !== 'string' || !VERSION.test(i.version))) {
      bad('info.version', 'must be 1-40 of letters, digits, ., +, _ and -, e.g. "2026.1"');
    }
    textKey(i.nameKey, 'info.nameKey', 'regimeName');
    if (typeof i.country === 'string' && /^[A-Z]{2}$/.test(i.country)) country = i.country;
    else bad('info.country', 'must be an ISO 3166-1 alpha-2 code');
    if (typeof i.currency === 'string' && /^[A-Z]{3}$/.test(i.currency)) currency = i.currency;
    else bad('info.currency', 'must be an ISO 4217 code (three capital letters)');
    if (!Array.isArray(i.sources) || i.sources.length === 0) {
      bad('info.sources', 'name at least one official source of the rules');
    } else {
      i.sources.forEach((u, n) => {
        if (!isUrl(u)) bad(`info.sources[${n}]`, 'must be an http(s) address');
      });
    }
  }

  const decimal = (v: unknown, path: string): v is string => {
    if (typeof v !== 'string' || v.length > 40 || !DECIMAL.test(v)) {
      bad(path, `must be a decimal written as text, e.g. "0.2" (got ${JSON.stringify(v)})`);
      return false;
    }
    // Texts show every digit (`regimeTextValues`); formatting keeps at most 20 decimals.
    if ((v.split('.')[1] ?? '').length > 20) {
      bad(path, 'at most 20 decimals');
      return false;
    }
    return true;
  };
  const rate = (v: unknown, path: string) => {
    if (decimal(v, path) && compareDecimalText(v, '1') > 0) bad(path, 'a rate is from 0 to 1');
  };
  /** A positive limit in the regime's currency; its amount, or undefined. */
  const limit = (v: unknown, path: string): string | undefined => {
    if (!fields(v, path, ['amount', 'currency'], ['amount', 'currency'])) return undefined;
    const m = v as Record<string, unknown>;
    if (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)) {
      bad(`${path}.currency`, 'must be an ISO 4217 code');
    } else if (currency && m.currency !== currency) {
      bad(`${path}.currency`, `must be the regime's currency ${currency} (got ${m.currency})`);
    }
    if (!decimal(m.amount, `${path}.amount`)) return undefined;
    if (compareDecimalText(m.amount, '0') === 0) {
      bad(`${path}.amount`, 'a limit is above 0 (leave it out for no limit)');
      return undefined;
    }
    return m.amount;
  };
  const annualVsLifetime = (
    annual: string | undefined,
    lifetime: string | undefined,
    path: string,
  ) => {
    if (annual && lifetime && compareDecimalText(annual, lifetime) > 0) {
      bad(path, `annual limit ${annual} is above the lifetime limit ${lifetime}`);
    }
  };
  const subset = <T extends string>(
    v: unknown,
    path: string,
    allowed: readonly T[],
    nonEmpty: boolean,
  ) => {
    if (!Array.isArray(v)) {
      bad(path, `must be a list of ${allowed.join(', ')}`);
      return [] as T[];
    }
    if (nonEmpty && v.length === 0) bad(path, 'name at least one');
    v.forEach((x, n) => {
      if (!(allowed as readonly unknown[]).includes(x)) {
        bad(`${path}[${n}]`, `must be one of ${allowed.join(', ')}`);
      }
    });
    if (new Set(v).size !== v.length) bad(path, 'names one twice');
    return v as T[];
  };
  // Every field checked with it is required: a missing one is reported once, as required.
  const oneOf = (v: unknown, path: string, allowed: readonly string[]) => {
    if (v !== undefined && !allowed.includes(v as string))
      bad(path, `must be one of ${allowed.join(', ')}`);
  };

  /** A withholding list: ISO country codes other than the regime's own, each once, rates 0..1. */
  const withholding = (list: unknown, path: string) => {
    if (!Array.isArray(list)) return bad(path, 'must be a list');
    const seen = new Set<unknown>();
    list.forEach((w, n) => {
      const wp = `${path}[${n}]`;
      if (!fields(w ?? null, wp, ['country', 'rate'], ['country', 'rate'])) return;
      const x = w as Record<string, unknown>;
      if (typeof x.country !== 'string' || !/^[A-Z]{2}$/.test(x.country)) {
        bad(`${wp}.country`, 'must be an ISO 3166-1 alpha-2 code');
      } else if (x.country === country) {
        bad(
          `${wp}.country`,
          "the regime's own country is not foreign (its dividends are taxed by the account type's rate)",
        );
      }
      if (seen.has(x.country)) bad(`${wp}.country`, `"${String(x.country)}" declared twice`);
      seen.add(x.country);
      rate(x.rate, `${wp}.rate`);
    });
  };

  // yearStart
  if (typeof r.yearStart !== 'string' || !validMonthDay(r.yearStart)) {
    bad('yearStart', 'must be a day of the year as MM-DD (not 02-29)');
  }
  // A settlement date needs each trade's settlement lag, which nothing declares yet; and the
  // rate on a settlement date can be later than the data known at the decision (`asOf`), so it
  // would have to be shown as pending, never replaced by the trade date's rate. Refused until a
  // lag source exists.
  for (const field of ['yearDate', 'fxDate'] as const) {
    oneOf(r[field], field, TRADE_DATES);
    if (r[field] === 'settlement_date') {
      bad(
        field,
        'settlement_date is refused for now: no settlement lag is declared yet; use trade_date',
      );
    }
  }

  const groups = Array.isArray(r.quotaGroups) ? r.quotaGroups : [];
  if (r.quotaGroups !== undefined && !Array.isArray(r.quotaGroups)) {
    bad('quotaGroups', 'must be a list');
  }

  // accountTypes
  const accountKeys = new Set<string>();
  const accounts = Array.isArray(r.accountTypes) ? r.accountTypes : [];
  if (!Array.isArray(r.accountTypes) || r.accountTypes.length === 0) {
    bad('accountTypes', 'declare at least the "taxable" account type');
  }
  for (const [n, a] of accounts.entries()) {
    const path = `accountTypes[${n}]`;
    if (!isObject(a)) continue;
    if (typeof a.key === 'string' && ITEM_KEY.test(a.key)) {
      if (accountKeys.has(a.key)) bad(`${path}.key`, `"${a.key}" declared twice`);
      accountKeys.add(a.key);
    }
  }

  // quotaGroups (before the account types: their limits bound the account types' limits)
  interface GroupLimits {
    path: string;
    annual?: string;
    lifetime?: string;
    declares: Set<'annual' | 'lifetime'>;
  }
  const groupsOf = new Map<string, GroupLimits[]>();
  const groupKeys = new Set<string>();
  groups.forEach((g, n) => {
    const path = `quotaGroups[${n}]`;
    if (!fields(g ?? null, path, GROUP_FIELDS, GROUP_REQUIRED)) return;
    const q = g as Record<string, unknown>;
    if (typeof q.key !== 'string' || !ITEM_KEY.test(q.key)) {
      bad(`${path}.key`, 'must be 2-40 of a-z, 0-9 and _, starting with a letter');
    } else if (groupKeys.has(q.key)) bad(`${path}.key`, `"${q.key}" declared twice`);
    else groupKeys.add(q.key);
    textKey(q.nameKey, `${path}.nameKey`, 'groupName');
    const annual = q.annual === undefined ? undefined : limit(q.annual, `${path}.annual`);
    const lifetime = q.lifetime === undefined ? undefined : limit(q.lifetime, `${path}.lifetime`);
    if (q.annual === undefined && q.lifetime === undefined) {
      bad(path, 'declare an annual or a lifetime limit');
    }
    annualVsLifetime(annual, lifetime, path);
    const declares = new Set<'annual' | 'lifetime'>();
    if (q.annual !== undefined) declares.add('annual');
    if (q.lifetime !== undefined) declares.add('lifetime');
    const limits: GroupLimits = {
      path,
      declares,
      ...(annual !== undefined && { annual }),
      ...(lifetime !== undefined && { lifetime }),
    };
    if (!Array.isArray(q.accountTypes) || q.accountTypes.length === 0) {
      bad(`${path}.accountTypes`, 'name at least one account type');
    } else {
      if (new Set(q.accountTypes).size !== q.accountTypes.length) {
        bad(`${path}.accountTypes`, 'names one twice');
      }
      q.accountTypes.forEach((k, m) => {
        if (typeof k !== 'string' || !accountKeys.has(k)) {
          bad(`${path}.accountTypes[${m}]`, `no account type "${String(k)}"`);
        } else groupsOf.set(k, [...(groupsOf.get(k) ?? []), limits]);
      });
    }
  });

  let taxable = false;
  for (const [n, a] of accounts.entries()) {
    const path = `accountTypes[${n}]`;
    if (!fields(a ?? null, path, ACCOUNT_FIELDS, ACCOUNT_REQUIRED)) continue;
    const t = a as Record<string, unknown>;
    if (typeof t.key !== 'string' || !ITEM_KEY.test(t.key)) {
      bad(`${path}.key`, 'must be 2-40 of a-z, 0-9 and _, starting with a letter');
    }
    oneOf(t.treatment, `${path}.treatment`, ['taxable', 'tax_advantaged']);
    if (t.key === 'taxable') {
      taxable = true;
      if (t.treatment !== 'taxable')
        bad(`${path}.treatment`, 'the "taxable" account type is taxable');
    }
    textKey(t.nameKey, `${path}.nameKey`, 'accountName');
    const ownGroups = typeof t.key === 'string' ? (groupsOf.get(t.key) ?? []) : [];

    const e = t.eligibility;
    if (fields(e, `${path}.eligibility`, ELIGIBILITY_FIELDS, ELIGIBILITY_REQUIRED)) {
      const el = e as Record<string, unknown>;
      if (typeof el.leveraged !== 'boolean')
        bad(`${path}.eligibility.leveraged`, 'must be true or false');
      if (el.assetClasses !== 'all') {
        if (
          !Array.isArray(el.assetClasses) ||
          el.assetClasses.length === 0 ||
          el.assetClasses.some((c) => typeof c !== 'string' || c.trim() === '' || c !== c.trim()) ||
          new Set(el.assetClasses).size !== el.assetClasses.length
        ) {
          bad(`${path}.eligibility.assetClasses`, '"all" or a list of distinct asset classes');
        }
      }
      if (el.designatedOnly !== undefined && typeof el.designatedOnly !== 'boolean') {
        bad(`${path}.eligibility.designatedOnly`, 'must be true or false');
      }
      subset(el.purchaseModes, `${path}.eligibility.purchaseModes`, PURCHASE_MODES, true);
    }

    if (t.quota !== undefined && fields(t.quota, `${path}.quota`, QUOTA_FIELDS, [])) {
      const q = t.quota as Record<string, unknown>;
      const annual = q.annual === undefined ? undefined : limit(q.annual, `${path}.quota.annual`);
      const lifetime =
        q.lifetime === undefined ? undefined : limit(q.lifetime, `${path}.quota.lifetime`);
      if (q.annual === undefined && q.lifetime === undefined) {
        bad(`${path}.quota`, 'declare an annual or a lifetime limit (leave quota out for none)');
      }
      annualVsLifetime(annual, lifetime, `${path}.quota`);
      // An account type's limit above a shared one it counts against could never be used.
      for (const g of ownGroups) {
        const above = (
          mine: string | undefined,
          what: string,
          theirs: string | undefined,
          of: string,
        ) => {
          if (mine && theirs && compareDecimalText(mine, theirs) > 0) {
            bad(
              `${path}.quota`,
              `${what} limit ${mine} is above the ${of} limit ${theirs} of ${g.path}`,
            );
          }
        };
        above(annual, 'annual', g.annual, 'annual');
        above(annual, 'annual', g.lifetime, 'lifetime');
        above(lifetime, 'lifetime', g.lifetime, 'lifetime');
      }
      if (
        q.release !== undefined &&
        fields(q.release, `${path}.quota.release`, RELEASE_FIELDS, RELEASE_FIELDS)
      ) {
        const rel = q.release as Record<string, unknown>;
        const limits = subset(
          rel.limits,
          `${path}.quota.release.limits`,
          ['annual', 'lifetime'],
          true,
        );
        for (const l of limits) {
          if (q[l] === undefined && !ownGroups.some((g) => g.declares.has(l))) {
            bad(
              `${path}.quota.release.limits`,
              `frees the ${l} limit, which neither the account type nor its groups declare`,
            );
          }
        }
        oneOf(rel.basis, `${path}.quota.release.basis`, ['book_value', 'proceeds']);
        oneOf(rel.from, `${path}.quota.release.from`, ['next_year', 'trade_date']);
      }
    }

    if (fields(t.tax, `${path}.tax`, TAX_FIELDS, TAX_FIELDS)) {
      const x = t.tax as Record<string, unknown>;
      rate(x.realizedGains, `${path}.tax.realizedGains`);
      rate(x.dividends, `${path}.tax.dividends`);
    }

    if (fields(t.losses, `${path}.losses`, LOSSES_FIELDS, LOSSES_FIELDS)) {
      const l = t.losses as Record<string, unknown>;
      subset(l.offsets, `${path}.losses.offsets`, LOSS_OFFSETS, false);
      const years = l.carryforwardYears;
      if (
        years !== 'unlimited' &&
        (typeof years !== 'number' ||
          !Number.isInteger(years) ||
          years < 0 ||
          years > MAX_CARRYFORWARD_YEARS)
      ) {
        bad(
          `${path}.losses.carryforwardYears`,
          `a whole number of years from 0 to ${MAX_CARRYFORWARD_YEARS}, or "unlimited"`,
        );
      }
      if (!Array.isArray(l.conditions)) bad(`${path}.losses.conditions`, 'must be a list');
      else {
        const seen = new Set<string>();
        const offsets = Array.isArray(l.offsets) ? l.offsets : [];
        l.conditions.forEach((c, m) => {
          const cp = `${path}.losses.conditions[${m}]`;
          const fieldsOk = fields(c ?? null, cp, LOSS_CONDITION_FIELDS, LOSS_CONDITION_FIELDS);
          if (!fieldsOk) return;
          const cond = c as Record<string, unknown>;
          oneOf(cond.kind, `${cp}.kind`, CONDITION_KINDS);
          const effects = subset(cond.appliesTo, `${cp}.appliesTo`, LOSS_CONDITION_EFFECTS, true);
          for (const effect of effects) {
            const id = `${String(cond.kind)} ${effect}`;
            if (seen.has(id)) bad(cp, `"${String(cond.kind)}" on ${effect} declared twice`);
            seen.add(id);
            if (effect === 'offsets' && offsets.length === 0) {
              bad(
                `${cp}.appliesTo`,
                'a condition on offsets, which the account type does not allow',
              );
            }
            if (effect === 'carryforward' && years === 0) {
              bad(`${cp}.appliesTo`, 'a condition on a carryforward of 0 years');
            }
          }
          textKey(
            cond.textKey,
            `${cp}.textKey`,
            'lossCondition',
            effects.includes('carryforward') && typeof years === 'number'
              ? ['carryforwardYears']
              : [],
          );
        });
      }
    }

    // The description receives what this account type has a value for.
    const quota = isObject(t.quota) ? t.quota : {};
    const groupDeclaring = (l: 'annual' | 'lifetime') =>
      ownGroups.filter((g) => g.declares.has(l)).length === 1;
    const carryforward = isObject(t.losses) ? t.losses.carryforwardYears : undefined;
    textKey(t.descriptionKey, `${path}.descriptionKey`, 'accountDescription', [
      'gainsRate',
      'dividendsRate',
      ...(quota.annual !== undefined ? ['annual'] : []),
      ...(quota.lifetime !== undefined ? ['lifetime'] : []),
      ...(groupDeclaring('annual') ? ['groupAnnual'] : []),
      ...(groupDeclaring('lifetime') ? ['groupLifetime'] : []),
      ...(typeof carryforward === 'number' ? ['carryforwardYears'] : []),
    ]);

    const credit = t.foreignTaxCredit;
    if (credit !== false) {
      const cp = `${path}.foreignTaxCredit`;
      if (!isObject(credit)) bad(cp, 'must be false or { conditions: [...] }');
      else if (fields(credit, cp, ['conditions'], ['conditions'])) {
        if (!Array.isArray(credit.conditions)) bad(`${cp}.conditions`, 'must be a list');
        else {
          const kinds = new Set<unknown>();
          credit.conditions.forEach((c, m) => {
            const kp = `${cp}.conditions[${m}]`;
            if (!fields(c ?? null, kp, ['kind', 'textKey'], ['kind', 'textKey'])) return;
            const cond = c as Record<string, unknown>;
            oneOf(cond.kind, `${kp}.kind`, CONDITION_KINDS);
            if (kinds.has(cond.kind)) bad(kp, `"${String(cond.kind)}" declared twice`);
            kinds.add(cond.kind);
            textKey(cond.textKey, `${kp}.textKey`, 'creditCondition');
          });
        }
      }
    }
    oneOf(t.foreignDividendBase, `${path}.foreignDividendBase`, FOREIGN_DIVIDEND_BASES);
    if (t.foreignWithholding !== undefined) {
      withholding(t.foreignWithholding, `${path}.foreignWithholding`);
    }
  }
  if (Array.isArray(r.accountTypes) && !taxable) {
    bad(
      'accountTypes',
      'a "taxable" account type is required (the default for timing and leveraged strategies)',
    );
  }

  // costBasis
  if (fields(r.costBasis, 'costBasis', ['method', 'sameDayOrder'], ['method', 'sameDayOrder'])) {
    const c = r.costBasis as Record<string, unknown>;
    oneOf(c.method, 'costBasis.method', LOT_METHODS);
    oneOf(c.sameDayOrder, 'costBasis.sameDayOrder', SAME_DAY_ORDERS);
  }

  // fx
  if (fields(r.fx, 'fx', FX_FIELDS, FX_FIELDS)) {
    const f = r.fx as Record<string, unknown>;
    const names = new Set<string>();
    /**
     * The rate name declared on each stored kind: rates are stored by kind (`fx_rates.kind`), not
     * by name, so two names on one kind would read the same stored rate (one could never be told
     * from the other). Refused.
     */
    const nameOfKind = new Map<unknown, string>();
    if (!isObject(f.rates) || Object.keys(f.rates).length === 0) {
      bad('fx.rates', 'name at least one rate');
    } else {
      for (const [name, def] of Object.entries(f.rates)) {
        const path = `fx.rates.${name}`;
        if (!RATE_NAME.test(name)) bad(path, 'a rate name is 1-20 of letters, digits, _ and -');
        else names.add(name);
        if (!fields(def ?? null, path, ['kind', 'nameKey'], ['kind', 'nameKey'])) continue;
        const d = def as Record<string, unknown>;
        oneOf(d.kind, `${path}.kind`, TAX_FX_KINDS);
        textKey(d.nameKey, `${path}.nameKey`, 'rateName');
        const other = nameOfKind.get(d.kind);
        if (other !== undefined) {
          bad(path, `${String(d.kind)} is already the kind of ${other}; one name per stored kind`);
        } else nameOfKind.set(d.kind, name);
      }
    }
    for (const use of ['purchases', 'sales', 'dividends'] as const) {
      if (typeof f[use] !== 'string' || !names.has(f[use])) {
        bad(
          `fx.${use}`,
          `must name one of the declared rates (${[...names].join(', ') || 'none'})`,
        );
      }
    }
  }

  // foreignWithholding
  if (!Array.isArray(r.foreignWithholding)) {
    bad('foreignWithholding', 'must be a list (empty: none declared)');
  } else withholding(r.foreignWithholding, 'foreignWithholding');

  // transfers
  if (!Array.isArray(r.transfers))
    bad('transfers', 'must be a list (empty: every move is a sale and a purchase)');
  else {
    const seen = new Set<string>();
    r.transfers.forEach((x, n) => {
      const path = `transfers[${n}]`;
      if (!fields(x ?? null, path, ['from', 'to'], ['from', 'to'])) return;
      const t = x as Record<string, unknown>;
      for (const end of ['from', 'to'] as const) {
        if (typeof t[end] !== 'string' || !accountKeys.has(t[end])) {
          bad(`${path}.${end}`, `no account type "${String(t[end])}"`);
        }
      }
      if (t.from === t.to) bad(path, 'a transfer is between two account types');
      const id = `${String(t.from)}>${String(t.to)}`;
      if (seen.has(id)) bad(path, 'declared twice');
      seen.add(id);
    });
  }

  // Placeholders: every language's texts use only what their kind receives.
  if (isObject(texts)) {
    for (const [lang, tree] of Object.entries(texts)) {
      if (textTreeProblem(tree)) continue;
      for (const key of leafKeys(tree as RegimeTexts)) {
        const text = lookup(tree as RegimeTexts, key)!;
        const allowed = allowedPlaceholders.get(key) ?? new Set<string>();
        if (/[{}]/.test(text.replace(PLACEHOLDER, ''))) {
          bad(`texts.${lang}.${key}`, 'braces only as {name} placeholders');
        }
        for (const [, name] of text.matchAll(PLACEHOLDER)) {
          if (!allowed.has(name!)) {
            bad(
              `texts.${lang}.${key}`,
              `placeholder {${name}} is not one this text receives (${[...allowed].join(', ') || 'none'})`,
            );
          }
        }
      }
    }
  }

  return problems;
}

const CONDITION_KINDS = ['filing'] as const;
const LOSS_CONDITION_FIELDS = ['kind', 'appliesTo', 'textKey'];

const REGIME_FIELDS = [
  'info',
  'yearStart',
  'yearDate',
  'fxDate',
  'accountTypes',
  'quotaGroups',
  'costBasis',
  'fx',
  'foreignWithholding',
  'transfers',
  'texts',
];
const REGIME_REQUIRED = REGIME_FIELDS.filter((f) => f !== 'quotaGroups');
const INFO_FIELDS = ['key', 'kind', 'version', 'nameKey', 'country', 'currency', 'sources'];
const ACCOUNT_FIELDS = [
  'key',
  'treatment',
  'nameKey',
  'descriptionKey',
  'eligibility',
  'quota',
  'tax',
  'losses',
  'foreignTaxCredit',
  'foreignDividendBase',
  'foreignWithholding',
];
const ACCOUNT_REQUIRED = ACCOUNT_FIELDS.filter((f) => f !== 'quota' && f !== 'foreignWithholding');
const ELIGIBILITY_FIELDS = ['leveraged', 'assetClasses', 'designatedOnly', 'purchaseModes'];
const ELIGIBILITY_REQUIRED = ['leveraged', 'assetClasses', 'purchaseModes'];
const QUOTA_FIELDS = ['annual', 'lifetime', 'release'];
const RELEASE_FIELDS = ['limits', 'basis', 'from'];
const TAX_FIELDS = ['realizedGains', 'dividends'];
const LOSSES_FIELDS = ['offsets', 'carryforwardYears', 'conditions'];
const GROUP_FIELDS = ['key', 'nameKey', 'accountTypes', 'annual', 'lifetime'];
const GROUP_REQUIRED = ['key', 'nameKey', 'accountTypes'];
const FX_FIELDS = ['rates', 'purchases', 'sales', 'dividends'];

function isUrl(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** `MM-DD` naming a day every year has (so not 02-29). */
function validMonthDay(v: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/** Why a value is not a text tree (nested objects of non-empty strings), or undefined. */
function textTreeProblem(tree: unknown): string | undefined {
  if (!isObject(tree)) return 'must be an object of texts';
  for (const [k, v] of Object.entries(tree)) {
    if (k === '' || k.includes('.')) return `key "${k}" must be non-empty without a dot`;
    if (typeof v === 'string') {
      if (v.trim() === '') return `text "${k}" is empty`;
    } else {
      const inner = textTreeProblem(v);
      if (inner) return `${k}: ${inner}`;
    }
  }
  return undefined;
}

/** Throws when a regime's declaration is not valid, naming every problem. */
export function validateTaxRegime(regime: TaxRegime): void {
  const problems = taxRegimeProblems(regime);
  if (problems.length > 0) {
    const key = isObject(regime) && isObject(regime.info) ? String(regime.info.key) : '?';
    throw new Error(`Tax regime "${key}" is refused: ${problems.join('; ')}.`);
  }
}

/** Validates every loaded regime, and that no two share a key. */
export function validateTaxRegimes(regimes: TaxRegime[]): void {
  const seen = new Set<string>();
  for (const regime of regimes) {
    validateTaxRegime(regime);
    if (seen.has(regime.info.key)) {
      throw new Error(`Two tax regime plug-ins use the key "${regime.info.key}".`);
    }
    seen.add(regime.info.key);
  }
}

/**
 * A translator for a regime's own texts in one language; a missing text falls back to English
 * (requirements 08: other languages may be partial). `{name}` placeholders are filled from
 * `values`; one left unfilled throws (a rule's amount must never show as `{annual}` or go
 * missing). Stricter than `@saku/content`'s translator, which leaves an unfilled placeholder as
 * it is. An unknown key throws (validation makes every declared key resolve).
 */
export function regimeTranslator(
  regime: Pick<TaxRegime, 'texts' | 'info'>,
  language: string,
): (key: string, values?: Record<string, string | number>) => string {
  const own = Object.hasOwn(regime.texts, language) ? regime.texts[language] : undefined;
  const base = regime.texts.en!;
  return (key, values = {}) => {
    const text = (own && lookup(own, key)) ?? lookup(base, key);
    if (text === undefined) {
      throw new Error(`Tax regime ${regime.info.key} has no text for ${key}.`);
    }
    return text.replace(PLACEHOLDER, (_, name: string) => {
      if (!Object.hasOwn(values, name)) {
        throw new Error(`Tax regime ${regime.info.key}: text ${key} needs a value for {${name}}.`);
      }
      return String(values[name]);
    });
  };
}

/**
 * The placeholder values of an account type's texts (its description and loss conditions), from
 * the declaration, formatted for `language`: rates as percentages and limits as amounts in the
 * regime's currency, every digit kept (decimal text is formatted as a string, never through a
 * float, with no rounding). Only what has a value is present (never an empty text): `annual`,
 * `lifetime` when the account type declares them, `groupAnnual`, `groupLifetime` when exactly one
 * of its groups declares one, `carryforwardYears` when a number. Validation allows a text only the
 * placeholders this returns. Throws for an account type the regime does not declare.
 */
export function regimeTextValues(
  regime: TaxRegime,
  accountKey: string,
  language: string,
): Record<string, string> {
  const account = regime.accountTypes.find((a) => a.key === accountKey);
  if (!account) {
    throw new Error(`Tax regime ${regime.info.key} has no account type ${accountKey}.`);
  }
  const percent = new Intl.NumberFormat(language, {
    style: 'percent',
    maximumFractionDigits: 20,
  });
  const money = (m: MoneyText) =>
    new Intl.NumberFormat(language, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 20,
    }).format(m.amount as `${number}`);
  const values: Record<string, string> = {
    gainsRate: percent.format(account.tax.realizedGains as `${number}`),
    dividendsRate: percent.format(account.tax.dividends as `${number}`),
  };
  if (account.quota?.annual) values.annual = money(account.quota.annual);
  if (account.quota?.lifetime) values.lifetime = money(account.quota.lifetime);
  const groups = (regime.quotaGroups ?? []).filter((g) => g.accountTypes.includes(accountKey));
  const annual = groups.filter((g) => g.annual);
  const lifetime = groups.filter((g) => g.lifetime);
  if (annual.length === 1) values.groupAnnual = money(annual[0]!.annual!);
  if (lifetime.length === 1) values.groupLifetime = money(lifetime[0]!.lifetime!);
  const years = account.losses.carryforwardYears;
  if (typeof years === 'number')
    values.carryforwardYears = new Intl.NumberFormat(language).format(years);
  return values;
}

/** The keys of the English texts a language lacks (empty: complete). */
export function regimeMissingTexts(regime: Pick<TaxRegime, 'texts'>, language: string): string[] {
  const own = regime.texts[language];
  return leafKeys(regime.texts.en!).filter(
    (k) => own === undefined || lookup(own, k) === undefined,
  );
}

/**
 * The fingerprint of a regime's rules: sha256 of the RFC 8785 canonical JSON of the declaration
 * without its texts (wording, not rules; amounts in texts are placeholders filled from the
 * declaration). Any change of a rule, key or text key changes it.
 */
export function taxRegimeFingerprint(regime: TaxRegime): string {
  const { texts: _texts, ...rules } = regime;
  return sha256(canonicalJson(rules as unknown as Json));
}

/** A loaded regime's declaration as the `tax_regime` setting stores it. */
export function taxRegimeDeclarationOf(regime: TaxRegime): TaxRegimeDeclaration {
  return {
    key: regime.info.key,
    version: regime.info.version,
    fingerprint: taxRegimeFingerprint(regime),
  };
}

/**
 * The install's tax regime: the loaded regime the `tax_regime` setting names, when its
 * declaration is the one the setting was made with. `unset` before the admin chose one;
 * `unknown` when no loaded regime has the key (removed or renamed since); `changed` when the
 * loaded declaration differs from the stored one (a plug-in update changed a rule): no tax
 * result may be computed then, until the admin sets the regime again (`pnpm plugins tax-regime`,
 * refused once users have tax data). Never a result under other rules than the ones chosen.
 */
export async function installTaxRegime(
  db: Db,
  regimes: readonly TaxRegime[],
): Promise<
  | { regime: TaxRegime }
  | { unset: true }
  | { unknown: string }
  | { changed: { key: string; version: string; setVersion: string | null } }
> {
  const key = await getSetting(db, 'tax_regime');
  if (key === undefined) return { unset: true };
  const regime = regimes.find((r) => r.info.key === key);
  if (!regime) return { unknown: key };
  const stored = await taxRegimeDeclaration(db);
  const valid = stored !== undefined && !('invalid' in stored) ? stored : undefined;
  if (!valid || valid.key !== key || valid.fingerprint !== taxRegimeFingerprint(regime)) {
    return { changed: { key, version: regime.info.version, setVersion: valid?.version ?? null } };
  }
  return { regime };
}

/** Sets the install's tax regime to a loaded regime (`checkTaxRegimeChange`), with its declaration. */
export async function setTaxRegime(
  db: Db,
  key: string,
  regimes: readonly TaxRegime[],
  actor = 'cli',
): Promise<void> {
  // The regime's account types: refused while stored benchmarks name one it does not define.
  const accountTypes = regimes.find((r) => r.info.key === key)?.accountTypes.map((a) => a.key);
  await setSetting(db, 'tax_regime', key, actor, {
    taxRegimes: regimes.map(taxRegimeDeclarationOf),
    ...(accountTypes && { accountTypes }),
  });
}
