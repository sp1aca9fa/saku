// A strategy file as `pnpm strategy check|register` reads it (cli/strategy.ts), without side
// effects so it can be tested. Requirements 05 "YAML": strategies are written in YAML (readable,
// with comments) and validated by zod; JSON files are read as before. Either way the parsed object
// goes through the same `Strategy` schema, so a YAML file and the equivalent JSON file register
// the same version (same canonical JSON, same hash).
//
// Registered versions are immutable, so the registered content must be exactly what the file
// says: anything YAML could read in more than one way is refused, never guessed (spec
// 2026-11-01 yaml-strategies):
// - YAML 1.2 core schema only: `on`, `yes`, `no`, `y` are strings (YAML 1.1 read them as
//   booleans); no timestamps or other 1.1 types; no custom or explicit tags (`!x`, `!!str`).
// - Duplicate keys are refused, and so are keys that are not plain strings (`1:` and `"1":`
//   would both become the key "1"; a later one would silently win).
// - Anchors and aliases (`&a`, `*a`) and merge keys (`<<`, a YAML 1.1 feature that 1.2 reads as
//   an ordinary key) are refused: write the values out.
// - One document per file; a `%YAML` directive other than 1.2 is refused; any parser warning
//   (an unknown directive or tag) is refused like an error.
// Every refusal names its line and column.
import { Strategy } from '@saku/core';
import { extname } from 'node:path';
import { LineCounter, type Node, isNode, isScalar, parseDocument, visit } from 'yaml';

export const STRATEGY_FILE_TYPES = ['.yaml', '.yml', '.json'] as const;

export type StrategyFileResult = { strategy: Strategy } | { error: string };

/** The plain value of a YAML strategy file, or every reason it is refused. */
export function parseStrategyYaml(text: string): { value: unknown } | { error: string } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    customTags: [],
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: true,
    lineCounter,
  });
  const problems: string[] = [];
  // The parser's messages already end with "at line N, column M:" and a code excerpt.
  for (const e of [...doc.errors, ...doc.warnings]) {
    const message = e.message.split('\n')[0]!.replace(/:$/, '');
    // The parser's own wording points at its API; say what to change in the file instead.
    problems.push(
      e.code === 'MULTIPLE_DOCS'
        ? message.replace(/^.*?(?= at line)/, 'A strategy file holds one YAML document (one ---)')
        : message,
    );
  }
  // The file is read as YAML 1.2 whatever it declares; one declaring another version means
  // something else by `yes` or `on`, so it is refused.
  if (doc.directives.yaml.explicit && doc.directives.yaml.version !== '1.2') {
    problems.push(`Only YAML 1.2 is read (the file declares %YAML ${doc.directives.yaml.version})`);
  }
  const at = (node: Node | null | undefined) => {
    const offset = node?.range?.[0];
    if (offset === undefined) return '';
    const { line, col } = lineCounter.linePos(offset);
    return ` at line ${line}, column ${col}`;
  };
  visit(doc, {
    Alias(_, node) {
      problems.push(`Aliases (*${node.source}) are not allowed; write the value out${at(node)}`);
    },
    Node(_, node) {
      if (node.anchor) {
        problems.push(`Anchors (&${node.anchor}) are not allowed${at(node)}`);
      }
      if (node.tag) problems.push(`Tags (${node.tag}) are not allowed${at(node)}`);
    },
    Pair(_, pair) {
      const key = isNode(pair.key) ? pair.key : null;
      if (!isScalar(key) || typeof key.value !== 'string') {
        problems.push(`Every key must be a plain name${at(key) || at(pair.value as Node)}`);
      } else if (key.value === '<<') {
        problems.push(`Merge keys (<<) are not allowed; write the keys out${at(key)}`);
      }
    },
  });
  if (problems.length > 0) return { error: problems.join('\n') };
  if (doc.contents === null) return { error: 'The file is empty.' };
  // No aliases are left (refused above), so none may be expanded.
  return { value: doc.toJS({ maxAliasCount: 0 }) };
}

/**
 * Reads a strategy file's text by its name's extension: `.yaml`/`.yml` (YAML, see above) or
 * `.json`; any other extension is refused. Then the same `Strategy` schema for both.
 */
export function parseStrategyFile(fileName: string, text: string): StrategyFileResult {
  const type = extname(fileName).toLowerCase();
  let value: unknown;
  if (type === '.yaml' || type === '.yml') {
    const read = parseStrategyYaml(text);
    if ('error' in read) return { error: `${fileName}:\n${read.error}` };
    value = read.value;
  } else if (type === '.json') {
    try {
      value = JSON.parse(text);
    } catch (e) {
      return { error: `${fileName}: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else {
    return {
      error: `${fileName}: a strategy file ends in ${STRATEGY_FILE_TYPES.join(', ')}.`,
    };
  }
  const parsed = Strategy.safeParse(value);
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'),
    };
  }
  return { strategy: parsed.data };
}
