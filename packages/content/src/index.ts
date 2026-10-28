// User-facing texts (requirements 08). `en.json` is the base and holds every text; other
// languages may be partial and fall back to English. Messages use ICU placeholders (`{name}`)
// so the files work unchanged with next-intl when the web app arrives (D1).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Tree = { [key: string]: string | Tree };

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages');
export const BASE_LANGUAGE = 'en';

const cache = new Map<string, Tree>();
function messages(language: string): Tree {
  let tree = cache.get(language);
  if (!tree) {
    tree = JSON.parse(readFileSync(join(DIR, `${language}.json`), 'utf8')) as Tree;
    cache.set(language, tree);
  }
  return tree;
}

/** Installed languages, found from the message files. */
export function languages(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A translator for one language; unknown languages and missing texts fall back to English. */
export function translator(language: string): Translate {
  const own = languages().includes(language) ? messages(language) : undefined;
  const base = messages(BASE_LANGUAGE);
  return (key, values = {}) => {
    const text = (own && lookup(own, key)) ?? lookup(base, key);
    if (text === undefined) throw new Error(`No text for ${key} in ${BASE_LANGUAGE}.json`);
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    );
  };
}

/** Keys each language lacks compared with the base (for `pnpm languages`, later). */
export function missingKeys(language: string): string[] {
  const keys = (tree: Tree, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([k, v]) =>
      typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`),
    );
  const own = messages(language);
  return keys(messages(BASE_LANGUAGE)).filter((k) => lookup(own, k) === undefined);
}
