import { readFileSync } from 'node:fs';

/** A saved provider answer from `test/fixtures/` (synthetic, in the provider's exact shape). */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
}
