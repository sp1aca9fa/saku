// Migration 0019: INSERT OR REPLACE cannot remove or move a protected row (its implicit delete
// fires no DELETE trigger). Raw SQL, as a hand edit or a careless tool would send it.
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from './testing';

const cases: { table: string; setup: string[]; replace: string; check: string; plain?: string }[] =
  [
    {
      table: 'user_tax_accounts',
      setup: [
        `INSERT INTO user_tax_accounts (id, owner_id, account_type, created_at) VALUES ('a1', 'u1', 'saver', 't')`,
      ],
      // Same id; and a new id for the same open owner and type (the open-row unique index).
      replace: `INSERT OR REPLACE INTO user_tax_accounts (id, owner_id, account_type, created_at) VALUES ('a1', 'u2', 'other', 't2')`,
      check: `SELECT id || owner_id || account_type AS v FROM user_tax_accounts`,
      plain: `INSERT INTO user_tax_accounts (id, owner_id, account_type, created_at) VALUES ('a2', 'u1', 'other', 't')`,
    },
    {
      table: 'user_tax_accounts (open owner and type)',
      setup: [
        `INSERT INTO user_tax_accounts (id, owner_id, account_type, created_at) VALUES ('a1', 'u1', 'saver', 't')`,
      ],
      replace: `INSERT OR REPLACE INTO user_tax_accounts (id, owner_id, account_type, created_at) VALUES ('a9', 'u1', 'saver', 't2')`,
      check: `SELECT id || owner_id || account_type AS v FROM user_tax_accounts`,
    },
    {
      table: 'stand_in_closes',
      setup: [
        `INSERT INTO stand_in_closes (id, symbol_id, date, source, close, band, basis, closed_by, reason, closed_at) VALUES (1, 1, '2026-01-05', 's', 10, 0.01, 'b', 'u1', 'why', 't')`,
      ],
      replace: `INSERT OR REPLACE INTO stand_in_closes (id, symbol_id, date, source, close, band, basis, closed_by, reason, closed_at) VALUES (1, 1, '2026-01-05', 's', 99, 0.01, 'b', 'u1', 'other', 't')`,
      check: `SELECT close || reason AS v FROM stand_in_closes`,
      plain: `INSERT INTO stand_in_closes (symbol_id, date, source, close, band, basis, closed_by, reason, closed_at) VALUES (1, '2026-01-06', 's', 10, 0.01, 'b', 'u1', 'why', 't')`,
    },
    {
      table: 'closed_event_resolutions',
      setup: [
        `INSERT INTO closed_event_resolutions (id, symbol_id, date, source, div_cash, split_factor, resolved_by, reason, resolved_at) VALUES (1, 1, '2026-01-05', 's', 0.5, 1, 'u1', 'why', 't')`,
      ],
      replace: `INSERT OR REPLACE INTO closed_event_resolutions (id, symbol_id, date, source, div_cash, split_factor, resolved_by, reason, resolved_at) VALUES (1, 1, '2026-01-05', 's', 0, 1, 'u1', 'other', 't')`,
      check: `SELECT div_cash || reason AS v FROM closed_event_resolutions`,
    },
    {
      table: 'red_rechecks',
      setup: [
        `INSERT INTO red_rechecks (id, version_id, date, first_red_at, reasons, deadline, provisional) VALUES (1, 'v1', '2026-01-05', 't', '[]', 'd', '{}')`,
      ],
      // A new id with the same version and date (the unique key).
      replace: `INSERT OR REPLACE INTO red_rechecks (id, version_id, date, first_red_at, reasons, deadline, provisional) VALUES (2, 'v1', '2026-01-05', 't2', '["x"]', 'd', '{}')`,
      check: `SELECT id || first_red_at || reasons AS v FROM red_rechecks`,
    },
    {
      table: 'strategy_versions',
      setup: [
        `INSERT INTO strategy_versions (id, name, canonical_json, registered_at, hash) VALUES ('v1', 'n', '{}', 't', 'h')`,
      ],
      replace: `INSERT OR REPLACE INTO strategy_versions (id, name, canonical_json, registered_at, hash) VALUES ('v1', 'n', '{"x":1}', 't', 'h2')`,
      check: `SELECT canonical_json || hash AS v FROM strategy_versions`,
    },
    {
      table: 'forward_entries',
      setup: [
        `INSERT INTO forward_entries (version_id, date, payload, allocation, holdings, safe_state_applied, data_status, prev_hash, hash, created_at) VALUES ('v1', '2026-01-05', '{}', 'A', '[]', 0, 'green', 'p', 'h', 't')`,
      ],
      replace: `INSERT OR REPLACE INTO forward_entries (version_id, date, payload, allocation, holdings, safe_state_applied, data_status, prev_hash, hash, created_at) VALUES ('v1', '2026-01-05', '{}', 'B', '[]', 0, 'green', 'p', 'h2', 't')`,
      check: `SELECT allocation || hash AS v FROM forward_entries`,
      plain: `INSERT INTO forward_entries (version_id, date, payload, allocation, holdings, safe_state_applied, data_status, prev_hash, hash, created_at) VALUES ('v1', '2026-01-06', '{}', 'A', '[]', 0, 'green', 'h', 'h3', 't')`,
    },
    {
      table: 'forward_annotations',
      setup: [
        `INSERT INTO forward_annotations (id, version_id, date, kind, detail, created_at) VALUES (1, 'v1', '2026-01-05', 'k', '{}', 't')`,
      ],
      replace: `INSERT OR REPLACE INTO forward_annotations (id, version_id, date, kind, detail, created_at) VALUES (1, 'v1', '2026-01-05', 'k', '{"x":1}', 't')`,
      check: `SELECT detail AS v FROM forward_annotations`,
      plain: `INSERT INTO forward_annotations (version_id, date, kind, detail, created_at) VALUES ('v1', '2026-01-06', 'k', '{}', 't')`,
    },
    {
      table: 'chain_anchors',
      setup: [
        `INSERT INTO chain_anchors (id, chain_head_hash, heads, anchored_at, method) VALUES (1, 'h', '[]', 't', 'rfc3161')`,
      ],
      replace: `INSERT OR REPLACE INTO chain_anchors (id, chain_head_hash, heads, anchored_at, method) VALUES (1, 'other', '[]', 't', 'rfc3161')`,
      check: `SELECT chain_head_hash AS v FROM chain_anchors`,
    },
  ];

describe('INSERT OR REPLACE cannot remove or move a protected row (0019)', () => {
  for (const c of cases) {
    it(c.table, async () => {
      const db = await testDb();
      // The guards are about keys; parent rows (users, symbols, versions) are left out.
      await db.run(sql.raw('PRAGMA foreign_keys = OFF'));
      for (const s of c.setup) await db.run(sql.raw(s));
      const before = await db.all<{ v: string }>(sql.raw(c.check));
      await expect(db.run(sql.raw(c.replace))).rejects.toThrow();
      // REPLACE INTO is the same statement.
      await expect(
        db.run(sql.raw(c.replace.replace('INSERT OR REPLACE', 'REPLACE'))),
      ).rejects.toThrow();
      expect(await db.all<{ v: string }>(sql.raw(c.check))).toEqual(before);
      // A new key still goes in.
      if (c.plain) {
        await db.run(sql.raw(c.plain));
        expect(await db.all(sql.raw(c.check))).toHaveLength(before.length + 1);
      }
    });
  }
});
