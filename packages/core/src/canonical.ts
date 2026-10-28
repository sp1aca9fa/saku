// RFC 8785 JSON Canonicalization Scheme: the exact text that is hashed for registrations and
// forward entries (requirements 05). Keys sorted by UTF-16 code units, numbers as ECMAScript
// prints them, strings with JSON's minimal escaping. The hashed text itself is stored.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON has no NaN or Infinity');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new Error('canonical JSON needs valid Unicode strings');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${canonicalJson(k)}:${canonicalJson(value[k]!)}`).join(',')}}`;
}
