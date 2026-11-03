import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARITY_DIR, PLUGIN_PACKAGES, PRIVATE_DIR, loadPlugins } from './registry';
import type { PluginInfo } from './types';

// The private submodule's folder is named in a few places that cannot share one constant (git,
// the test runner, the typecheck script, prettier). A place left on an old name skips the private
// package silently (no tests, no typecheck, no plug-ins, no parity cases), so they are checked
// against `.gitmodules`, where git reads the path (requirements 12 and 15).
const ROOT = join(import.meta.dirname, '../../..');
const text = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** The submodules `.gitmodules` declares, by name. */
function submodules(): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of text('.gitmodules').split('\n')) {
    const section = /^\s*\[submodule "([^"]+)"\]\s*$/.exec(line);
    if (section) {
      name = section[1]!;
      continue;
    }
    const path = /^\s*path\s*=\s*(\S+)\s*$/.exec(line);
    if (path && name !== undefined) found.set(name, path[1]!);
  }
  return found;
}

describe('the private folder', () => {
  it('is the path .gitmodules gives the one submodule, whose name stays plugins', () => {
    // The name keys the server's submodule url (its deploy-key alias) and its module folder.
    expect([...submodules()]).toEqual([['plugins', PRIVATE_DIR]]);
    expect(PRIVATE_DIR).toBe('private');
    expect(PLUGIN_PACKAGES.filter((p) => p.private).map((p) => p.dir)).toEqual([PRIVATE_DIR]);
  });

  it('holds the testfol parity cases, which the jobs read from there', () => {
    expect(PARITY_DIR).toBe(join(PRIVATE_DIR, 'test', 'testfol'));
    const jobs = text('packages/plugin-sdk/src/cli/jobs.ts');
    expect(jobs).toContain('parityDir: join(findRepoRoot(), PARITY_DIR)');
    expect(jobs).not.toMatch(/'plugins'/);
  });

  it('is the folder the tests, the typecheck and prettier name', () => {
    expect(text('vitest.config.ts')).toContain(
      `existsSync('${PRIVATE_DIR}/package.json') ? ['${PRIVATE_DIR}']`,
    );
    const typecheck = text('scripts/typecheck-plugins.mjs');
    expect(typecheck).toContain(`existsSync('${PRIVATE_DIR}/tsconfig.json')`);
    expect(typecheck).toContain(`'-p', '${PRIVATE_DIR}'`);
    expect(text('.prettierignore').split('\n')).toContain(`${PRIVATE_DIR}/`);
    for (const file of [
      'vitest.config.ts',
      'scripts/typecheck-plugins.mjs',
      '.prettierignore',
      'ops/update-server.sh',
    ]) {
      expect(text(file), file).not.toMatch(/(^|[^-\w@])plugins\/|'plugins'|-C plugins\b/m);
    }
  });

  it('is what loads; a leftover plugins/ folder from before the move is not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saku-private-'));
    try {
      const entry = (folder: string, key: string) => {
        const info: PluginInfo = {
          key,
          kind: 'bar',
          name: 'Example Data',
          provides: { tickers: ['AAA'] },
          suggestedRole: 'secondary',
          termsUrl: 'https://example.test/terms',
        };
        mkdirSync(join(root, folder, 'src'), { recursive: true });
        writeFileSync(
          join(root, folder, 'src', 'index.ts'),
          `export const bars = [{ info: ${JSON.stringify(info)}, fetchBars: async () => [] }];`,
        );
      };
      entry('plugins-public', 'example-public');
      entry(PRIVATE_DIR, 'example-private');
      entry('plugins', 'example-leftover');
      const loaded = await loadPlugins(root);
      expect(loaded.bars.map((b) => b.info.key)).toEqual(['example-public', 'example-private']);
      expect(loaded.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
