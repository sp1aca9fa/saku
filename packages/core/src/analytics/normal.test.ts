// Reference values: Python's math.erfc (correctly rounded within an ulp) and
// statistics.NormalDist.inv_cdf (Wichura's AS241).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalCdf, normalQuantile, normalUpperQuantile } from './normal';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('normal distribution', () => {
  it('Phi matches the reference values', () => {
    const cases: [number, number][] = [
      [-1, 0.15865525393145707],
      [1, 0.8413447460685429],
      [0.3, 0.6179114221889526],
      [-0.5, 0.3085375387259869],
      [-0.9999, 0.1586794522137626],
      [-1.0001, 0.15863105806885874],
      [-2, 0.02275013194817922],
      [-3, 0.0013498980316300957],
      [-6, 9.865876450377012e-10],
      [-8, 6.220960574271819e-16],
    ];
    for (const [z, want] of cases) expect(rel(normalCdf(z), want), String(z)).toBeLessThan(1e-13);
    expect(rel(normalCdf(-20), 2.7536241186063314e-89)).toBeLessThan(1e-11);
    expect(rel(normalCdf(-37), 5.725571222525139e-300)).toBeLessThan(1e-11);
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(-Infinity)).toBe(0);
    expect(normalCdf(Infinity)).toBe(1);
  });

  it('PhiInv matches the reference values', () => {
    const cases: [number, number][] = [
      [0.01, -2.3263478740408408],
      [0.975, 1.9599639845400536],
      [1e-10, -6.361340902404056],
      [1 / (100 * Math.E), -2.6802104449668818],
    ];
    for (const [p, want] of cases)
      expect(rel(normalQuantile(p), want), String(p)).toBeLessThan(1e-14);
    expect(normalQuantile(0.5)).toBe(0);
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalUpperQuantile(0.01)).toBe(-normalQuantile(0.01));
    expect(() => normalQuantile(1.5)).toThrow('[0, 1]');
    expect(() => normalQuantile(NaN)).toThrow('[0, 1]');
  });

  it('PhiInv inverts Phi', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-300, max: 0.5, noNaN: true }), (p) => {
        return rel(normalCdf(normalQuantile(p)), p) < 1e-12;
      }),
    );
  });
});
