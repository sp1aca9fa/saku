// The C2 settings: broker cost defaults, the deposit rate and the benchmark set (requirements 01
// "Benchmark set", 05 "Costs", 09 "Cost model before C1", 12; spec 2026-11-02 c2-settings).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appSettings } from './schema';
import {
  type Benchmark,
  benchmarkAccountProblems,
  benchmarkSet,
  brokerCosts,
  depositRate,
  duplicateJsonKeys,
  getSetting,
  parseBenchmarks,
  parseBrokerCosts,
  parseDepositRate,
  setSetting,
} from './settings';
import { testDb } from './testing';

const problemsOf = (r: object) => ('problems' in r ? (r.problems as string[]) : []);

describe('duplicateJsonKeys', () => {
  it('finds a key given twice in one object, at any depth, escapes read', () => {
    expect(duplicateJsonKeys('{"a":1,"b":2}')).toEqual([]);
    expect(duplicateJsonKeys('{"a":1,"a":2}')).toEqual(['a']);
    expect(duplicateJsonKeys('{"a" : 1, "\\u0061": 2}')).toEqual(['a']);
    // The same key in different objects is fine; nested objects are their own.
    expect(duplicateJsonKeys('[{"a":1},{"a":2}]')).toEqual([]);
    expect(duplicateJsonKeys('{"a":{"a":1},"b":{"x":1,"x":2}}')).toEqual(['x']);
    // Values that look like keys are not keys; quotes and braces inside strings are text.
    expect(duplicateJsonKeys('{"a":"a","b":"a"}')).toEqual([]);
    expect(duplicateJsonKeys('{"a":"}\\":{","b":1}')).toEqual([]);
    expect(duplicateJsonKeys('{"a\\\\":1,"a\\\\":2}')).toEqual(['a\\']);
  });
});

describe('broker_costs', () => {
  const good = '{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0.2"}';

  it('reads three decimal texts, none invented', async () => {
    expect(parseBrokerCosts(good)).toEqual({
      costs: { slippageBps: '5', feePct: '0.1', fxSpreadPct: '0.2' },
    });
    // Zero is stated, not assumed; the maxima are inclusive for slippage, exclusive for percents.
    expect(parseBrokerCosts('{"slippageBps":"1000","feePct":"0","fxSpreadPct":"99.99"}')).toEqual({
      costs: { slippageBps: '1000', feePct: '0', fxSpreadPct: '99.99' },
    });
    const db = await testDb();
    expect(await brokerCosts(db)).toEqual({ unset: true });
    await setSetting(db, 'broker_costs', good);
    expect(await brokerCosts(db)).toEqual(parseBrokerCosts(good));
  });

  it.each([
    ['not JSON', 'five', /not valid JSON/],
    ['a list', '[]', /must be a JSON object/],
    ['a field left out', '{"slippageBps":"5","feePct":"0.1"}', /"fxSpreadPct" is required/],
    [
      'an unknown key',
      `{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0","fee":"1"}`,
      /unknown key "fee"/,
    ],
    [
      'a key twice',
      '{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0","feePct":"9"}',
      /"feePct" is given twice/,
    ],
    [
      'a number',
      '{"slippageBps":5,"feePct":"0.1","fxSpreadPct":"0"}',
      /slippageBps must be a decimal written as text/,
    ],
    [
      'a negative',
      '{"slippageBps":"-1","feePct":"0.1","fxSpreadPct":"0"}',
      /slippageBps must be a decimal/,
    ],
    [
      'an exponent',
      '{"slippageBps":"1e2","feePct":"0.1","fxSpreadPct":"0"}',
      /slippageBps must be a decimal/,
    ],
    [
      'a padding zero',
      '{"slippageBps":"05","feePct":"0.1","fxSpreadPct":"0"}',
      /slippageBps must be a decimal/,
    ],
    ['a comma', '{"slippageBps":"5","feePct":"0,1","fxSpreadPct":"0"}', /feePct must be a decimal/],
    [
      'slippage above 1000 bps',
      '{"slippageBps":"1000.01","feePct":"0.1","fxSpreadPct":"0"}',
      /slippageBps must be at most 1000/,
    ],
    [
      'a fee of 100%',
      '{"slippageBps":"5","feePct":"100","fxSpreadPct":"0"}',
      /feePct must be below 100/,
    ],
    [
      'a spread above 100%',
      '{"slippageBps":"5","feePct":"0","fxSpreadPct":"250"}',
      /fxSpreadPct must be below 100/,
    ],
    [
      '16 significant digits',
      '{"slippageBps":"5","feePct":"0.1234567890123456","fxSpreadPct":"0"}',
      /15 significant digits/,
    ],
  ])('refuses %s, with the reason', async (_, text, reason) => {
    expect(problemsOf(parseBrokerCosts(text)).join('\n')).toMatch(reason);
    const db = await testDb();
    await expect(setSetting(db, 'broker_costs', text)).rejects.toThrow(reason);
    expect(await getSetting(db, 'broker_costs')).toBeUndefined();
  });

  it('lists every problem at once', () => {
    expect(problemsOf(parseBrokerCosts('{"slippageBps":"x","fee":"1"}'))).toEqual([
      'unknown key "fee" (keys: slippageBps, feePct, fxSpreadPct)',
      '"feePct" is required',
      '"fxSpreadPct" is required',
      'slippageBps must be a decimal written as text, e.g. "0.2" (got "x")',
    ]);
  });

  it('reports a stored value that no longer parses (a hand edit), never as unset', async () => {
    const db = await testDb();
    await db.insert(appSettings).values({ key: 'broker_costs', value: '{"feePct":"0.1"}' });
    expect(await brokerCosts(db)).toEqual({
      invalid: ['"slippageBps" is required', '"fxSpreadPct" is required'],
    });
  });
});

describe('deposit_rate', () => {
  const rate = (o: object = {}) =>
    JSON.stringify({ ratePct: '0.2', asOf: '2026-10-01', currency: 'XXX', ...o });

  it("reads the base currency's dated rate", async () => {
    const db = await testDb();
    expect(await depositRate(db)).toEqual({ unset: true });
    // The base currency first: the rate is that currency's.
    await expect(setSetting(db, 'deposit_rate', rate())).rejects.toThrow(/base_currency first/);
    await setSetting(db, 'base_currency', 'XXX');
    await expect(setSetting(db, 'deposit_rate', rate({ currency: 'YYY' }))).rejects.toThrow(
      /its currency must be XXX \(got YYY\)/,
    );
    await setSetting(db, 'deposit_rate', rate());
    expect(await depositRate(db)).toEqual({
      rate: { ratePct: '0.2', asOf: '2026-10-01', currency: 'XXX' },
    });
    await setSetting(db, 'deposit_rate', rate({ ratePct: '0' }));
    expect(await depositRate(db)).toMatchObject({ rate: { ratePct: '0' } });
  });

  it.each([
    ['a rate as a number', { ratePct: 0.2 }, /ratePct must be a decimal written as text/],
    ['a negative rate', { ratePct: '-0.1' }, /ratePct must be a decimal/],
    ['a rate of 1000%', { ratePct: '1000' }, /ratePct must be below 1000/],
    ['no date', { asOf: undefined }, /"asOf" is required/],
    ['a date that does not exist', { asOf: '2026-02-30' }, /asOf must be a date/],
    ['a date with a time', { asOf: '2026-10-01T00:00' }, /asOf must be a date/],
    ['a currency in lower case', { currency: 'xxx' }, /currency must be an ISO 4217 code/],
    ['an unknown key', { bank: 'x' }, /unknown key "bank"/],
  ])('refuses %s', (_, o, reason) => {
    expect(problemsOf(parseDepositRate(rate(o))).join('\n')).toMatch(reason);
  });

  it('reports a stored rate in another currency than the base (a hand edit) as invalid', async () => {
    const db = await testDb();
    await setSetting(db, 'base_currency', 'XXX');
    await db.insert(appSettings).values({ key: 'deposit_rate', value: rate({ currency: 'YYY' }) });
    expect(await depositRate(db)).toEqual({
      invalid: ['currency YYY is not the base currency XXX'],
    });
  });
});

describe('benchmarks', () => {
  const one = (o: Partial<Record<keyof Benchmark, unknown>> = {}) => ({
    id: 'mix',
    holdings: [
      { ticker: 'AAA', weight: 60 },
      { ticker: 'BBB', weight: 40 },
    ],
    feePctPerYear: '0.1',
    account: 'taxable',
    ...o,
  });
  const text = (...bs: object[]) => JSON.stringify(bs);
  const problem = (...bs: object[]) => problemsOf(parseBenchmarks(text(...bs))).join('\n');

  it('reads the template', () => {
    const file = readFileSync(
      join(import.meta.dirname, '../../../templates/benchmarks/example.json'),
      'utf8',
    );
    const parsed = parseBenchmarks(file);
    expect(problemsOf(parsed)).toEqual([]);
    expect(('benchmarks' in parsed ? parsed.benchmarks : []).map((b) => b.id)).toEqual([
      'us_stocks',
      'global_stocks',
      'stocks_bonds_60_40',
      'deposits',
    ]);
  });

  it('reads tickers in the strict grammar and DEPOSIT, weights adding up to 100 within 1e-9 relative', () => {
    expect(
      problem(one(), one({ id: 'cash', holdings: [{ ticker: 'DEPOSIT', weight: 100 }] })),
    ).toBe('');
    expect(problem(one({ holdings: [{ ticker: 'AAA?L=2&E=0.5', weight: 100 }] }))).toBe('');
    const thirds = [1, 2, 3].map((n) => ({ ticker: `T${n}`, weight: 100 / 3 }));
    expect(problem(one({ holdings: thirds }))).toBe('');
    // 1e-7 off is within 1e-9 of 100; 1e-6 is not.
    const off = (d: number) => [
      { ticker: 'AAA', weight: 60 + d },
      { ticker: 'BBB', weight: 40 },
    ];
    expect(problem(one({ holdings: off(0.5e-7) }))).toBe('');
    expect(problem(one({ holdings: off(1e-6) }))).toMatch(/weights must add up to 100/);
  });

  it.each([
    ['an empty list', [], /non-empty JSON list/],
    ['an object instead of a list', one(), /non-empty JSON list/],
    ['an id used twice', [one(), one()], /"mix": id is used twice/],
    ['an id with a capital', [one({ id: 'Mix' })], /id must be lowercase/],
    ['an id starting with a digit', [one({ id: '6040' })], /id must be lowercase/],
    ['an id with a dash', [one({ id: 'a-b' })], /id must be lowercase/],
    ['no holdings', [one({ holdings: [] })], /holdings must be a non-empty list/],
    [
      'weights not adding up',
      [one({ holdings: [{ ticker: 'AAA', weight: 60 }] })],
      /add up to 100 \(they add up to 60\)/,
    ],
    [
      'a weight of 0',
      [
        one({
          holdings: [
            { ticker: 'AAA', weight: 0 },
            { ticker: 'B', weight: 100 },
          ],
        }),
      ],
      /weight must be a number above 0/,
    ],
    [
      'a weight as text',
      [one({ holdings: [{ ticker: 'AAA', weight: '100' }] })],
      /weight must be a number/,
    ],
    [
      'a ticker twice',
      [
        one({
          holdings: [
            { ticker: 'AAA', weight: 50 },
            { ticker: 'AAA', weight: 50 },
          ],
        }),
      ],
      /"AAA" is listed twice/,
    ],
    [
      'a malformed ticker',
      [one({ holdings: [{ ticker: 'AAA?L=', weight: 100 }] })],
      /L must be a plain decimal/,
    ],
    [
      'a ticker with a space',
      [one({ holdings: [{ ticker: 'A A', weight: 100 }] })],
      /without spaces/,
    ],
    [
      'DEPOSIT with a parameter',
      [one({ holdings: [{ ticker: 'DEPOSIT?L=2', weight: 100 }] })],
      /DEPOSIT takes no parameters/,
    ],
    [
      'a fee as a number',
      [one({ feePctPerYear: 0.1 })],
      /feePctPerYear must be a decimal written as text/,
    ],
    ['a fee of 100%', [one({ feePctPerYear: '100' })], /feePctPerYear must be below 100/],
    [
      'an account not in key form',
      [one({ account: 'Tax Free' })],
      /account must be an account type key/,
    ],
    ['an unknown key', [{ ...one(), name: 'Mix' }], /unknown key "name"/],
    [
      'a missing key',
      [{ id: 'mix', holdings: one().holdings, account: 'taxable' }],
      /"feePctPerYear" is required/,
    ],
  ])('refuses %s', (_, list, reason) => {
    expect(problemsOf(parseBenchmarks(JSON.stringify(list))).join('\n')).toMatch(reason);
  });

  it('refuses a key given twice, which JSON.parse would read as the last', () => {
    const twice =
      '[{"id":"mix","holdings":[{"ticker":"AAA","weight":100,"weight":50}],"feePctPerYear":"0","account":"taxable"}]';
    expect(problemsOf(parseBenchmarks(twice))).toEqual(['"weight" is given twice in one object']);
  });

  it("is set only with the regime's account types at hand, each benchmark's account among them", async () => {
    const db = await testDb();
    const value = text(one(), one({ id: 'free', account: 'tax_free' }));
    await expect(setSetting(db, 'benchmarks', value)).rejects.toThrow(/pnpm plugins benchmarks/);
    await expect(
      setSetting(db, 'benchmarks', value, 'cli', { accountTypes: ['taxable'] }),
    ).rejects.toThrow(
      /"free": the install's tax regime has no account type "tax_free" \(it has: taxable\)/,
    );
    expect(await benchmarkSet(db)).toEqual({ unset: true });
    await setSetting(db, 'benchmarks', value, 'cli', { accountTypes: ['taxable', 'tax_free'] });
    expect(await benchmarkSet(db)).toEqual({ benchmarks: JSON.parse(value) });
    // A regime set later without that account type: the reader that loads it says so.
    const set = await benchmarkSet(db);
    expect(
      benchmarkAccountProblems('benchmarks' in set ? set.benchmarks : [], ['taxable']),
    ).toEqual([
      `"free": the install's tax regime has no account type "tax_free" (it has: taxable)`,
    ]);
    // A stored value that no longer parses (a hand edit) is reported, never read as unset.
    await db.update(appSettings).set({ value: '[]' });
    expect(await benchmarkSet(db)).toMatchObject({ invalid: [expect.stringMatching(/non-empty/)] });
  });
});
