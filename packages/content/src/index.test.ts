import { describe, expect, it } from 'vitest';
import { benchmarkLabel, benchmarkName, languages, missingKeys, translator } from './index';

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

describe('benchmarkLabel', () => {
  it('shows what a benchmark holds next to its name, the deposit rate by name', () => {
    const mix = {
      id: 'stocks_bonds_60_40',
      holdings: [
        { ticker: 'VTI', weight: 60 },
        { ticker: 'AGG', weight: 40 },
      ],
    };
    expect(benchmarkLabel(translator('en'), mix)).toBe('Stocks and bonds (VTI 60%, AGG 40%)');
    expect(benchmarkLabel(translator('ja'), mix)).toBe('株式と債券(VTI 60%, AGG 40%)');
    const deposits = { id: 'deposits', holdings: [{ ticker: 'DEPOSIT', weight: 100 }] };
    expect(benchmarkLabel(translator('en'), deposits)).toBe('Bank deposits (deposit rate 100%)');
    expect(benchmarkLabel(translator('en'), { ...deposits, id: 'own' })).toBe(
      'own (deposit rate 100%)',
    );
  });
});
