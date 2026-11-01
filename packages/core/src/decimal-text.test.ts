import { describe, expect, it } from 'vitest';
import {
  compareDecimalText,
  decimalTextProblem,
  floatDecimalTextProblem,
  significantDigits,
} from './decimal-text';

describe('decimal text', () => {
  it('accepts plain non-negative decimals only', () => {
    for (const ok of ['0', '0.0', '5', '0.1', '1000', '12.50', `0.${'1'.repeat(20)}`]) {
      expect(decimalTextProblem(ok)).toBeUndefined();
    }
    for (const bad of [
      '',
      '-1',
      '+1',
      '1e2',
      '05',
      '.5',
      '5.',
      '1,5',
      ' 1',
      '1 ',
      'NaN',
      5,
      null,
    ]) {
      expect(decimalTextProblem(bad)).toMatch(/must be a decimal written as text/);
    }
    expect(decimalTextProblem(`0.${'1'.repeat(21)}`)).toMatch(/at most 20 decimals/);
    expect(decimalTextProblem('1'.repeat(41))).toMatch(/must be a decimal/);
  });

  it('counts significant digits, and refuses more than 15 where floats read the value', () => {
    expect(significantDigits('0')).toBe(0);
    expect(significantDigits('0.0250')).toBe(2);
    expect(significantDigits('100.5')).toBe(4);
    expect(significantDigits('1000')).toBe(1);
    expect(floatDecimalTextProblem('0.123456789012345')).toBeUndefined();
    expect(floatDecimalTextProblem('0.1234567890123456')).toMatch(/15 significant digits/);
    expect(floatDecimalTextProblem('-1')).toMatch(/must be a decimal/);
    // Up to 15 significant digits a float64 holds the text's value: the 15-digit form of the
    // float is the text (IEEE 754 binary64, DBL_DIG = 15).
    for (const [t, fifteen] of [
      ['0.1', '0.100000000000000'],
      ['0.20315', '0.203150000000000'],
      ['99.9999999999999', '99.9999999999999'],
      ['123456.789012345', '123456.789012345'],
    ]) {
      expect(Number(t).toPrecision(15)).toBe(fifteen);
    }
  });

  it('compares exactly, without floats', () => {
    expect(compareDecimalText('0.1', '0.10')).toBe(0);
    expect(compareDecimalText('1000', '999.999')).toBe(1);
    expect(compareDecimalText('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimalText('0.10000000000000000001', '0.1')).toBe(1);
  });
});
