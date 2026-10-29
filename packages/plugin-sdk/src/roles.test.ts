import { describe, expect, it } from 'vitest';
import { emptyPlugins } from './registry';
import { assignedOnly, dataKindOf, unassigned } from './roles';
import type { BarSource, IssuerSource, PluginInfo } from './types';

const info = (key: string, kind: PluginInfo['kind']): PluginInfo => ({
  key,
  kind,
  name: key,
  provides: {},
  suggestedRole: 'check',
  termsUrl: 'https://example.test',
});
const bar = (key: string): BarSource => ({ info: info(key, 'bar'), fetchBars: async () => [] });
const issuer = (key: string): IssuerSource => ({
  info: info(key, 'issuer'),
  supports: () => true,
  fetchRecords: async () => [],
});

describe('source roles', () => {
  it('uses only the issuer sources that have a role for issuer data', () => {
    const plugins = { ...emptyPlugins(), bars: [bar('p')], issuers: [issuer('i1'), issuer('i2')] };
    const roles = [
      { dataKind: 'bars', pluginKey: 'p' },
      { dataKind: 'issuer', pluginKey: 'i1' },
      // A role under another data kind does not count.
      { dataKind: 'bars', pluginKey: 'i2' },
    ];
    const used = assignedOnly(plugins, roles);
    expect(used.issuers.map((i) => i.info.key)).toEqual(['i1']);
    expect(used.bars.map((b) => b.info.key)).toEqual(['p']);
    expect(dataKindOf(info('x', 'issuer'))).toBe('issuer');
    expect(
      unassigned([info('i1', 'issuer'), info('i2', 'issuer')], roles).map((i) => i.key),
    ).toEqual(['i2']);
  });
});
