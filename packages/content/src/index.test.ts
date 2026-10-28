import { describe, expect, it } from 'vitest';
import { languages, missingKeys, translator } from './index';

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
