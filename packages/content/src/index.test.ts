import { describe, expect, it } from 'vitest';
import { benchmarkName, languages, missingKeys, translator } from './index';

describe('content', () => {
  it('fills placeholders and falls back to English', () => {
    expect(translator('en')('alerts.cash', { currency: 'USD' })).toBe('Cash (USD)');
    expect(translator('ja')('alerts.cash', { currency: 'USD' })).toBe('現金(USD)');
    expect(translator('xx')('alerts.cash', { currency: 'EUR' })).toBe('Cash (EUR)');
    expect(() => translator('en')('alerts.nothing')).toThrow();
  });

  it('has every base text in the owner install languages', () => {
    expect(languages()).toEqual(expect.arrayContaining(['en', 'ja']));
    expect(missingKeys('ja')).toEqual([]);
  });
});

describe('benchmarkName', () => {
  it('reads benchmarks.<id> when the content has it, else shows the id', () => {
    expect(benchmarkName(translator('en'), 'deposits')).toBe('Bank deposits');
    expect(benchmarkName(translator('ja'), 'deposits')).toBe('銀行預金');
    expect(benchmarkName(translator('en'), 'my_own_mix')).toBe('my_own_mix');
    // An id that names something on every object is still only an id.
    expect(benchmarkName(translator('en'), 'constructor')).toBe('constructor');
  });
});
