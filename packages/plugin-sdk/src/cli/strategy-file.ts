// A strategy file as `pnpm strategy check|register` reads it (cli/strategy.ts), without side
// effects so it can be tested. Requirements 05 "YAML": strategies are written in YAML (readable,
// with comments) and validated by zod; JSON files are read too. Either way the parsed object goes
// through the same strict `Strategy` schema (an unknown key is refused), so a YAML file and the
// equivalent JSON file register the same version (same canonical JSON, same hash).
//
// Registered versions are immutable, so the registered content must be exactly what the file
// says: anything that could be read in more than one way is refused, never guessed (spec
// 2026-11-01 yaml-strategies):
// - YAML 1.2 core schema only: `on`, `yes`, `no`, `y` are strings (YAML 1.1 read them as
//   booleans); no timestamps or other 1.1 types; no custom or explicit tags (`!x`, `!!str`).
// - Duplicate keys are refused (in JSON files too, where `JSON.parse` would keep the last), and
//   so are YAML keys that are not plain strings (`1:` and `"1":` would both become the key "1").
// - Anchors and aliases (`&a`, `*a`) and merge keys (`<<`, a YAML 1.1 feature that 1.2 reads as
//   an ordinary key) are refused: write the values out.
// - A comment right after an unquoted text value on its line (`name: Setup #1` reads as
//   "Setup"), or on the next non-blank line indented further than the value's key or dash:
//   quote the value, or put the comment on its own line at the key's indentation. After numbers,
//   booleans, quoted values and brackets a comment is fine.
// - One document per file; a `%YAML` directive other than 1.2 is refused; any parser warning
//   (an unknown directive or tag) is refused like an error.
// Every refusal names its line and column; so do the schema's, where the path is in the file.
import { Strategy } from '@saku/core';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  type Document,
  LineCounter,
  type Node,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from 'yaml';

export const STRATEGY_FILE_TYPES = ['.yaml', '.yml', '.json'] as const;

export type StrategyFileResult = { strategy: Strategy } | { error: string };

/** A parsed file with its positions, for the schema's messages. */
interface Located {
  value: unknown;
  doc: Document.Parsed;
  lineCounter: LineCounter;
}

const position = (lineCounter: LineCounter, node: Node | null | undefined) => {
  const offset = node?.range?.[0];
  if (offset === undefined) return '';
  const { line, col } = lineCounter.linePos(offset);
  return ` at line ${line}, column ${col}`;
};

/** The first line of a parser message (it ends with "at line N, column M:" and an excerpt). */
const firstLine = (message: string) => message.split('\n')[0]!.replace(/:$/, '');

/**
 * The 0-based column of what owns a scalar in block style: its key (a block mapping's value) or
 * its dash (a block sequence's item). Undefined elsewhere (a key itself, flow collections, the
 * document's only value).
 */
function blockColumn(
  node: Node,
  parent: unknown,
  grandparent: unknown,
  start: number,
  lineCounter: LineCounter,
  text: string,
): number | undefined {
  if (isPair(parent) && parent.value === node && isNode(parent.key)) {
    if (!isMap(grandparent) || grandparent.flow) return undefined;
    const keyStart = parent.key.range?.[0];
    return keyStart === undefined ? undefined : lineCounter.linePos(keyStart).col - 1;
  }
  if (isSeq(parent) && !parent.flow) {
    const dash = text.lastIndexOf('-', start);
    return dash < 0 ? undefined : lineCounter.linePos(dash).col - 1;
  }
  return undefined;
}

function readYaml(text: string): Located | { error: string } {
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
  for (const e of [...doc.errors, ...doc.warnings]) {
    const message = firstLine(e.message);
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
  const at = (node: Node | null | undefined) => position(lineCounter, node);
  visit(doc, {
    Alias(_, node) {
      problems.push(`Aliases (*${node.source}) are not allowed; write the value out${at(node)}`);
    },
    Scalar(_, node, path) {
      if (node.anchor) problems.push(`Anchors (&${node.anchor}) are not allowed${at(node)}`);
      if (node.tag) problems.push(`Tags (${node.tag}) are not allowed${at(node)}`);
      // An unquoted text value followed by a comment, on its line (`name: Setup #1`) or on the
      // next non-blank line indented further than its key or dash (`name: Setup` then
      // `  #1 version`, which YAML reads as the end of the text): the `#` may have been meant
      // as part of the text, so the value would silently be "Setup". Numbers, booleans and null
      // are not text. A comment line at the key's indentation or less is clearly its own.
      const start = node.range?.[0];
      const end = node.range?.[1];
      if (
        node.type !== 'PLAIN' ||
        typeof node.value !== 'string' ||
        start === undefined ||
        end === undefined
      ) {
        return;
      }
      const [sameLine, ...below] = text.slice(end).split('\n');
      let commented = /^[ \t]+#/.test(sameLine!);
      const owner = blockColumn(node, path.at(-1), path.at(-2), start, lineCounter, text);
      const next = below.find((line) => line.trim() !== '');
      if (!commented && owner !== undefined && next !== undefined) {
        const comment = /^([ \t]*)#/.exec(next);
        commented = comment !== null && comment[1]!.length > owner;
      }
      if (commented) {
        problems.push(
          `A comment follows the unquoted text "${node.value}"${at(node)}: if the # belongs ` +
            `to it, quote it ("${node.value} #..."); else put the comment on its own line, ` +
            `not indented under the value`,
        );
      }
    },
    Collection(_, node) {
      if (node.anchor) problems.push(`Anchors (&${node.anchor}) are not allowed${at(node)}`);
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
  // `---` alone, or nothing but comments.
  const c = doc.contents;
  if (c === null || (isScalar(c) && c.value === null && c.source === '')) {
    return { error: 'The file is empty.' };
  }
  // No aliases are left (refused above), so none may be expanded.
  return { value: doc.toJS({ maxAliasCount: 0 }), doc, lineCounter };
}

/** The plain value of a YAML strategy file, or every reason it is refused. */
export function parseStrategyYaml(text: string): { value: unknown } | { error: string } {
  const read = readYaml(text);
  return 'error' in read ? read : { value: read.value };
}

/**
 * A JSON file: `JSON.parse` is the syntax gate (as before); the same text read as YAML's JSON
 * schema only finds duplicate keys (which `JSON.parse` resolves silently, the last one winning)
 * with their lines, and gives the schema's messages their lines.
 */
function readJson(text: string): Located | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    schema: 'json',
    uniqueKeys: true,
    prettyErrors: true,
    lineCounter,
  });
  const duplicates = doc.errors.filter((e) => e.code === 'DUPLICATE_KEY');
  if (duplicates.length > 0) {
    return { error: duplicates.map((e) => firstLine(e.message)).join('\n') };
  }
  return { value, doc, lineCounter };
}

/** One of the schema's issues (zod's issue type, without importing zod here). */
type Issue = NonNullable<ReturnType<typeof Strategy.safeParse>['error']>['issues'][number];

/**
 * A schema issue for the reader. For a union (an operand is an indicator or a threshold), the
 * alternative with the fewest issues says best what is wrong (the first on a tie); the refusal
 * itself does not depend on this choice.
 */
function readable(issue: Issue): Issue[] {
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const best = issue.errors.reduce((a, b) => (b.length < a.length ? b : a));
    if (best.length > 0) {
      return best.flatMap((i) => readable({ ...i, path: [...issue.path, ...i.path] } as Issue));
    }
  }
  return [issue];
}

/** Where in the file an issue is: its node, else the nearest enclosing one that exists. */
function issueAt(file: Located, issue: Issue): string {
  const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
  if (issue.code === 'unrecognized_keys') {
    const parent = file.doc.getIn(path, true);
    if (isMap(parent)) {
      const pair = parent.items.find(
        (p) => isScalar(p.key) && issue.keys.includes(String(p.key.value)),
      );
      if (pair && isNode(pair.key)) return position(file.lineCounter, pair.key);
    }
  }
  for (let n = path.length; n >= 0; n--) {
    const node = file.doc.getIn(path.slice(0, n), true);
    if (isNode(node)) return position(file.lineCounter, node);
  }
  return '';
}

/**
 * Reads a strategy file's text by its name's extension: `.yaml`/`.yml` (YAML, see above) or
 * `.json`; any other extension is refused. Then the same `Strategy` schema for both.
 */
export function parseStrategyFile(fileName: string, text: string): StrategyFileResult {
  const type = extname(fileName).toLowerCase();
  let read: Located | { error: string };
  if (type === '.yaml' || type === '.yml') {
    read = readYaml(text);
    if ('error' in read) return { error: `${fileName}:\n${read.error}` };
  } else if (type === '.json') {
    read = readJson(text);
    if ('error' in read) return { error: `${fileName}: ${read.error}` };
  } else {
    return {
      error: `${fileName}: a strategy file ends in ${STRATEGY_FILE_TYPES.join(', ')}.`,
    };
  }
  const file = read;
  const parsed = Strategy.safeParse(file.value);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .flatMap(readable)
        // A top-level issue has no path: its message alone (as forward.ts parseVersion prints).
        .map(
          (i) =>
            `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}` +
            issueAt(file, i),
        )
        .join('\n'),
    };
  }
  return { strategy: parsed.data };
}

/**
 * Reads and parses a strategy file. `shown`: the name to print (as the user typed it). A missing
 * file says so in one line.
 */
export function readStrategyFile(path: string, shown = path): StrategyFileResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { error: `No file ${shown}.` };
    if (code === 'EISDIR') return { error: `${shown} is a folder, not a strategy file.` };
    return { error: `${shown}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseStrategyFile(shown, text);
}

/**
 * What a file registers, as read (printed by `check` and before `register` writes): the name and
 * the fields that decide what is traded, so a misread value shows before it becomes immutable.
 */
export function strategySummary(s: Strategy): string[] {
  const holdings = (hs: { ticker: string; weight: number }[]) =>
    hs.map((h) => `${h.ticker} ${h.weight}%`).join(', ');
  return [
    `Name: "${s.name}"`,
    `Account: ${s.account}; execution: ${s.execution}; evaluation: ${s.evaluation.frequency}`,
    `Safe state: ${holdings(s.safeState.holdings)}`,
    `Signals: ${s.signals.map((x) => x.id).join(', ') || 'none'}`,
    ...s.allocations.map(
      (a) =>
        `Allocation "${a.name}"${a.when ? ` when ${JSON.stringify(a.when)}` : ' otherwise'}: ` +
        holdings(a.holdings),
    ),
  ];
}
