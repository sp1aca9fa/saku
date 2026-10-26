import { describe, expect, it } from 'vitest';
import { assertServerOnly } from './server-only';

describe('assertServerOnly', () => {
  it('passes on a plain server environment', () => {
    expect(() => assertServerOnly({})).not.toThrow();
  });

  it('refuses when CI or VERCEL is set', () => {
    expect(() => assertServerOnly({ CI: 'true' })).toThrow(/CI/);
    expect(() => assertServerOnly({ VERCEL: '1' })).toThrow(/VERCEL/);
  });

  it('ignores empty values', () => {
    expect(() => assertServerOnly({ CI: '' })).not.toThrow();
  });
});
