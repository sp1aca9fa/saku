// Verifying the forward records now (requirements 05, integrity rules), as `pnpm strategy verify`
// does and the monthly audit report states: every registered version's hash chain (registration
// hash, each entry's hash and link, canonical text, columns as hashed; `verifyChain`), then every
// daily anchor (its hash over the heads, each head found in the record, the timestamp token
// checked against the CA file). Read-only.
import { type Db, allVersions, forwardRecord, schema, sha256, verifyChain } from '@saku/db';
import { verifyToken } from './anchor';

export interface ChainCheck {
  versions: { id: string; name: string; problems: string[] }[];
  anchors: { date: string; authority: string | null; problems: string[] }[];
}

/** Verifies every chain and anchor. `token`: the token check (default `verifyToken`, openssl). */
export async function verifyChains(
  db: Db,
  o: { caFile: string; token?: typeof verifyToken },
): Promise<ChainCheck> {
  const token = o.token ?? verifyToken;
  const versions = await allVersions(db);
  const out: ChainCheck = { versions: [], anchors: [] };
  for (const v of versions) {
    out.versions.push({ id: v.id, name: v.name, problems: await verifyChain(db, v) });
  }
  for (const a of await db.select().from(schema.chainAnchors)) {
    const problems: string[] = [];
    let heads: { date?: unknown; heads?: unknown } | undefined;
    try {
      heads = JSON.parse(a.heads) as typeof heads;
    } catch {
      // A stored anchor that does not parse is a problem to report, never a crash or a pass.
      problems.push('heads not readable');
    }
    if (sha256(a.heads) !== a.chainHeadHash) problems.push('hash');
    const listed = heads?.heads;
    if (heads && (typeof listed !== 'object' || listed === null)) problems.push('no heads');
    for (const [versionId, hash] of Object.entries((listed ?? {}) as Record<string, unknown>)) {
      const known =
        (await forwardRecord(db, versionId)).some((e) => e.hash === hash) ||
        versions.some((v) => v.id === versionId && v.hash === hash);
      if (!known) problems.push(`head of ${versionId} not in the record`);
    }
    if (!a.proof || !(await token(a.proof as Uint8Array, a.chainHeadHash, o.caFile))) {
      problems.push('timestamp token');
    }
    out.anchors.push({
      date: typeof heads?.date === 'string' ? heads.date : 'unknown date',
      authority: a.authority,
      problems,
    });
  }
  return out;
}

/** The lines `pnpm strategy verify` prints: one per version, then one per anchor. */
export function chainLines(c: ChainCheck): string[] {
  return [
    ...c.versions.map(
      (v) => `${v.name} (${v.id}): ${v.problems.length ? v.problems.join('; ') : 'chain ok'}`,
    ),
    ...c.anchors.map(
      (a) =>
        `Anchor ${a.date} (${a.authority}): ${a.problems.length ? a.problems.join('; ') : 'ok'}`,
    ),
  ];
}

/** Versions and anchors with a problem. */
export function chainProblems(c: ChainCheck): number {
  return [...c.versions, ...c.anchors].filter((x) => x.problems.length > 0).length;
}
