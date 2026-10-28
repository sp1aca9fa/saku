// Daily external timestamp of the forward records' chain heads (requirements 05, system design 8):
// an RFC 3161 token from a timestamp authority over the hash of {date, heads}, made and checked
// with `openssl ts` (no npm dependency). Authorities in `SAKU_TSA_URLS` (comma list, tried in
// order); tokens are verified against `SAKU_TSA_CAFILE` (default: the system's CA bundle).
import { type TradingDate, canonicalJson } from '@saku/core';
import { type Db, allVersions, lastEntry, schema, sha256 } from '@saku/db';
import { stateDir } from '@saku/db/env';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { desc } from 'drizzle-orm';
import { PoliteHttp } from '../http';

const run = promisify(execFile);
export const SYSTEM_CA = '/etc/ssl/certs/ca-certificates.crt';

export interface AnchorOptions {
  date: TradingDate;
  authorities: string[];
  caFile?: string;
  http?: PoliteHttp;
}

export type AnchorResult =
  | { status: 'anchored'; authority: string; digest: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; errors: string[] };

/** The text that is timestamped: every version's chain head on the date. */
export async function chainHeads(db: Db, date: TradingDate): Promise<string> {
  const heads: Record<string, string> = {};
  for (const v of await allVersions(db)) heads[v.id] = (await lastEntry(db, v.id))?.hash ?? v.hash;
  return canonicalJson({ kind: 'anchor', date, heads });
}

/** Checks a token covers the digest and is signed by a trusted authority. */
export async function verifyToken(token: Uint8Array, digest: string, caFile: string) {
  const dir = await scratch();
  try {
    const file = join(dir, 'reply.tsr');
    await writeFile(file, token);
    await run('openssl', ['ts', '-verify', '-digest', digest, '-in', file, '-CAfile', caFile]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function anchor(db: Db, o: AnchorOptions): Promise<AnchorResult> {
  if (o.authorities.length === 0)
    return { status: 'skipped', reason: 'no authority (SAKU_TSA_URLS)' };
  const versions = await allVersions(db);
  if (versions.length === 0) return { status: 'skipped', reason: 'nothing registered' };
  const [last] = await db
    .select()
    .from(schema.chainAnchors)
    .orderBy(desc(schema.chainAnchors.id))
    .limit(1);
  if (last && (JSON.parse(last.heads) as { date: string }).date === o.date) {
    return { status: 'skipped', reason: `already anchored for ${o.date}` };
  }

  const heads = await chainHeads(db, o.date);
  const digest = sha256(heads);
  const caFile = o.caFile ?? SYSTEM_CA;
  const errors: string[] = [];
  const dir = await scratch();
  try {
    const query = join(dir, 'query.tsq');
    await run('openssl', ['ts', '-query', '-digest', digest, '-sha256', '-cert', '-out', query]);
    const body = new Uint8Array(await readFile(query));
    for (const authority of o.authorities) {
      try {
        const http = o.http ?? new PoliteHttp({ retries: 2 });
        const { data } = await http.post(authority, body, {
          'Content-Type': 'application/timestamp-query',
        });
        const reply = join(dir, 'reply.tsr');
        await writeFile(reply, data);
        await run('openssl', [
          'ts',
          '-verify',
          '-queryfile',
          query,
          '-in',
          reply,
          '-CAfile',
          caFile,
        ]);
        await db.insert(schema.chainAnchors).values({
          chainHeadHash: digest,
          heads,
          anchoredAt: new Date().toISOString(),
          method: 'rfc3161',
          authority,
          proof: Buffer.from(data),
        });
        return { status: 'anchored', authority, digest };
      } catch (e) {
        errors.push(`${authority}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { status: 'failed', errors };
}

/** A private scratch folder for openssl's files. */
async function scratch(): Promise<string> {
  await mkdir(stateDir(), { recursive: true });
  return mkdtemp(join(stateDir(), 'tsa-'));
}
