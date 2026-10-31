// Strategy files in YAML or JSON (requirements 05 "YAML"; spec 2026-11-01 yaml-strategies): the
// same schema, the same registered version, and anything ambiguous refused with its line.
import { canonicalJson } from '@saku/core';
import { registerVersion } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { parseStrategyFile, parseStrategyYaml } from './strategy-file';

const JSON_TEXT = JSON.stringify({
  name: 'Example trend',
  account: 'taxable',
  execution: 'next_open',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  costs: { slippageBps: 5, feePct: 0.1 },
  signals: [
    {
      id: 'up',
      type: 'compare',
      left: { indicator: 'price', ticker: 'AAA', totalReturn: true },
      op: '>',
      right: { indicator: 'sma', ticker: 'AAA', length: 200, totalReturn: true },
      tolerancePct: 3,
    },
  ],
  allocations: [
    { name: 'In', when: { all: ['up'] }, holdings: [{ ticker: 'AAA?L=3', weight: 100 }] },
    { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
});

// The same strategy in YAML, keys in another order, with comments.
const YAML_TEXT = `# An example: AAA leveraged while above its 200-day average.
account: taxable
name: Example trend
evaluation: { frequency: daily }
execution: next_open
safeState:
  holdings:
    - { ticker: AAA, weight: 100 }
costs: { feePct: 0.1, slippageBps: 5 }
signals:
  - id: up # the trend
    type: compare
    left: { indicator: price, ticker: AAA, totalReturn: true }
    op: '>'
    right: { indicator: sma, ticker: AAA, length: 200, totalReturn: true }
    tolerancePct: 3
allocations:
  - name: In
    when: { all: [up] }
    holdings:
      - { ticker: "AAA?L=3", weight: 100 }
  - name: Out
    holdings:
      - { ticker: CASH_USD, weight: 100 }
`;

const ok = (name: string, text: string) => {
  const r = parseStrategyFile(name, text);
  if ('error' in r) throw new Error(r.error);
  return r.strategy;
};
const error = (name: string, text: string) => {
  const r = parseStrategyFile(name, text);
  if (!('error' in r)) throw new Error('expected a refusal');
  return r.error;
};
const value = (text: string) => {
  const r = parseStrategyYaml(text);
  if ('error' in r) throw new Error(r.error);
  return r.value;
};
const yamlError = (text: string) => {
  const r = parseStrategyYaml(text);
  if (!('error' in r)) throw new Error('expected a refusal');
  return r.error;
};

describe('strategy files', () => {
  it('a YAML file and the equivalent JSON file register the same version (same hash)', async () => {
    const fromYaml = ok('example.yaml', YAML_TEXT);
    const fromJson = ok('example.json', JSON_TEXT);
    expect(fromYaml).toEqual(fromJson);
    expect(canonicalJson(fromYaml)).toBe(canonicalJson(fromJson));
    expect(ok('example.yml', YAML_TEXT)).toEqual(fromJson);
    const db = await testDb();
    const at = new Date('2026-11-02T00:00:00Z');
    const register = (strategy: typeof fromYaml) =>
      registerVersion(db, { ownerId: null, name: strategy.name, strategy, at });
    const [a, b] = [await register(fromYaml), await register(fromJson)];
    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.hash).toBe(b.hash);
  });

  it('JSON files read as before; other extensions are refused', () => {
    expect(ok('example.JSON', JSON_TEXT).name).toBe('Example trend');
    expect(error('example.json', '{"name": ')).toMatch(/^example\.json: /);
    expect(error('example.txt', YAML_TEXT)).toBe(
      'example.txt: a strategy file ends in .yaml, .yml, .json.',
    );
    expect(error('example', JSON_TEXT)).toMatch(/ends in \.yaml, \.yml, \.json/);
  });

  it('the schema refuses what it refused before, from YAML too', () => {
    expect(
      error(
        'x.yaml',
        YAML_TEXT.replace('weight: 100 }\n  - name: Out', 'weight: 90 }\n  - name: Out'),
      ),
    ).toContain('weights must add up to 100');
    expect(error('x.yaml', '[1, 2]\n')).toMatch(/expected object/);
    expect(error('x.yaml', '')).toBe('x.yaml:\nThe file is empty.');
    expect(error('x.yaml', '# only a comment\n')).toBe('x.yaml:\nThe file is empty.');
  });

  it('YAML 1.2 core: on, yes, no, y stay strings; numbers stay numbers', () => {
    expect(value('a: on\nb: yes\nc: no\nd: y\ne: off\nf: On\n')).toEqual({
      a: 'on',
      b: 'yes',
      c: 'no',
      d: 'y',
      e: 'off',
      f: 'On',
    });
    expect(value('a: true\nb: false\nc: null\nd: ~\n')).toEqual({
      a: true,
      b: false,
      c: null,
      d: null,
    });
    expect(value('a: 0.5\nb: 25\nc: 25.0\nd: -3\ne: 1e-3\n')).toEqual({
      a: 0.5,
      b: 25,
      c: 25,
      d: -3,
      e: 0.001,
    });
    // Not numbers in the 1.2 core schema (1.1 read some of these as numbers or dates).
    expect(value('a: 1_000\nb: 2026-11-02\nc: 1:30\nd: "25"\n')).toEqual({
      a: '1_000',
      b: '2026-11-02',
      c: '1:30',
      d: '25',
    });
  });

  it('a signal id like "on" or "no" stays a string through the schema', () => {
    const s = ok('x.yaml', YAML_TEXT.replace('- id: up', '- id: on').replace('[up]', '[on]'));
    expect(s.signals[0]!.id).toBe('on');
    expect(s.allocations[0]!.when).toEqual({ all: ['on'] });
  });

  it('a ticker with an option reads the same quoted or not', () => {
    expect(value('t: "SPY?L=3"\n')).toEqual({ t: 'SPY?L=3' });
    expect(value("t: 'SPY?L=3'\n")).toEqual({ t: 'SPY?L=3' });
    expect(value('t: SPY?L=3\n')).toEqual({ t: 'SPY?L=3' });
  });

  it('infinite and not-a-number values are refused by the schema', () => {
    expect(error('x.yaml', YAML_TEXT.replace('tolerancePct: 3', 'tolerancePct: .inf'))).toContain(
      'tolerancePct',
    );
    expect(error('x.yaml', YAML_TEXT.replace('tolerancePct: 3', 'tolerancePct: .nan'))).toContain(
      'tolerancePct',
    );
    expect(error('x.yaml', YAML_TEXT.replace('tolerancePct: 3', 'tolerancePct: 1e400'))).toContain(
      'tolerancePct',
    );
  });

  it('a duplicate key is refused with its line', () => {
    expect(yamlError('name: a\naccount: b\nname: c\n')).toMatch(/unique at line 3, column 1/);
    expect(yamlError('x: { a: 1, a: 2 }\n')).toMatch(/unique at line 1/);
    // The file name comes first, then the reasons.
    expect(error('x.yaml', YAML_TEXT + 'name: again\n')).toMatch(/^x\.yaml:\n.*unique at line \d+/);
  });

  it('keys that are not plain names are refused (1 and "1" would collide)', () => {
    expect(yamlError('1: a\n"1": b\n')).toMatch(/plain name at line 1, column 1/);
    expect(yamlError('a: 1\nnull: 2\n')).toMatch(/plain name at line 2/);
    expect(yamlError('true: 1\n')).toMatch(/plain name at line 1/);
    expect(yamlError('? [a]\n: b\n')).toMatch(/plain name at line 1/);
    expect(yamlError(': x\n')).toMatch(/plain name at line 1/);
  });

  it('anchors, aliases and merge keys are refused', () => {
    expect(yamlError('a: &x 1\nb: *x\n')).toMatch(/Aliases \(\*x\) .* at line 2, column 4/);
    expect(yamlError('a: &x 1\n')).toMatch(/Anchors \(&x\) .* at line 1/);
    expect(yamlError('base: { a: 1 }\nc:\n  <<: { a: 1 }\n')).toMatch(
      /Merge keys \(<<\) .* at line 3, column 3/,
    );
  });

  it('tags are refused, standard ones too', () => {
    expect(yamlError('a: !foo 1\n')).toMatch(/at line 1/);
    expect(yamlError('a: !!str 1\n')).toMatch(/Tags \(tag:yaml\.org,2002:str\) .* at line 1/);
    expect(yamlError('a: !!float 1\n')).toMatch(/Tags/);
    expect(yamlError('!!map { a: 1 }\n')).toMatch(/Tags/);
  });

  it('several documents, another YAML version and unknown directives are refused', () => {
    expect(yamlError('a: 1\n---\nb: 2\n')).toBe(
      'A strategy file holds one YAML document (one ---) at line 2, column 1',
    );
    expect(yamlError('%YAML 1.1\n---\na: yes\n')).toBe(
      'Only YAML 1.2 is read (the file declares %YAML 1.1)',
    );
    expect(value('%YAML 1.2\n---\na: yes\n')).toEqual({ a: 'yes' });
    expect(yamlError('%FOO bar\n---\na: 1\n')).toMatch(/Unknown directive/);
  });

  it('a syntax error names its line', () => {
    expect(yamlError('a: [1, 2\nb: 3\n')).toMatch(/line \d+, column \d+/);
    expect(yamlError('a: 1\n  b: 2\n')).toMatch(/at line 1, column 4/);
    expect(yamlError('a:\n\t- 1\n')).toMatch(/line 2/);
  });
});
