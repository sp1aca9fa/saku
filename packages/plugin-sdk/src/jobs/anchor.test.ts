// The anchoring flow against a throwaway local timestamp authority made with openssl (no network).
import { createUser, registerVersion, schema } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PoliteHttp } from '../http';
import { anchor, verifyToken } from './anchor';

const dir = mkdtempSync(join(tmpdir(), 'saku-tsa-'));
const ca = join(dir, 'tsa.crt');
const config = join(dir, 'tsa.cnf');

beforeAll(() => {
  process.env.SAKU_STATE_DIR = join(dir, 'state');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(dir, 'tsa.key'),
      '-out',
      ca,
      '-subj',
      '/CN=Example TSA',
      '-days',
      '2',
      '-addext',
      'extendedKeyUsage=critical,timeStamping',
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(join(dir, 'serial'), '01\n');
  writeFileSync(
    config,
    [
      '[ tsa ]',
      'default_tsa = local',
      '[ local ]',
      `serial = ${join(dir, 'serial')}`,
      `signer_cert = ${ca}`,
      `signer_key = ${join(dir, 'tsa.key')}`,
      'signer_digest = sha256',
      'default_policy = 1.2.3.4.1',
      'digests = sha256',
      'ess_cert_id_alg = sha256',
      'ess_cert_id_chain = no',
    ].join('\n'),
  );
});

/** A fetch that answers timestamp queries like a TSA would. */
const localTsa = (async (_url: string, init?: RequestInit) => {
  const query = join(dir, 'q.tsq');
  const reply = join(dir, 'r.tsr');
  writeFileSync(query, init!.body as Uint8Array);
  execFileSync('openssl', ['ts', '-reply', '-config', config, '-queryfile', query, '-out', reply], {
    stdio: 'ignore',
  });
  return new Response(readFileSync(reply), {
    headers: { 'content-type': 'application/timestamp-reply' },
  });
}) as typeof fetch;

async function setup() {
  const db = await testDb();
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await registerVersion(db, { ownerId: owner, name: 'S', strategy: {} });
  return db;
}

describe('anchor', () => {
  it('timestamps the chain heads once a day and keeps a token that verifies', async () => {
    const db = await setup();
    const http = new PoliteHttp({ fetchImpl: localTsa, minDelayMs: 0 });
    const r = await anchor(db, {
      date: '2026-02-02',
      authorities: ['https://tsa.example.test'],
      caFile: ca,
      http,
    });
    expect(r.status).toBe('anchored');
    const [row] = await db.select().from(schema.chainAnchors);
    expect(row).toMatchObject({ method: 'rfc3161', authority: 'https://tsa.example.test' });
    expect(await verifyToken(row!.proof as Uint8Array, row!.chainHeadHash, ca)).toBe(true);
    expect(await verifyToken(row!.proof as Uint8Array, 'ab'.repeat(32), ca)).toBe(false);
    const again = await anchor(db, {
      date: '2026-02-02',
      authorities: ['https://tsa.example.test'],
      caFile: ca,
      http,
    });
    expect(again.status).toBe('skipped');
  });

  it('falls back to the next authority, and fails when none answers with a valid token', async () => {
    const db = await setup();
    let calls = 0;
    const flaky = (async (url: string, init?: RequestInit) => {
      calls++;
      return url.includes('broken') ? new Response('not a token') : localTsa(url, init);
    }) as typeof fetch;
    const http = new PoliteHttp({ fetchImpl: flaky, minDelayMs: 0 });
    const r = await anchor(db, {
      date: '2026-02-03',
      authorities: ['https://broken.example.test', 'https://tsa.example.test'],
      caFile: ca,
      http,
    });
    expect(r).toMatchObject({ status: 'anchored', authority: 'https://tsa.example.test' });
    expect(calls).toBe(2);
    const none = await anchor(db, {
      date: '2026-02-04',
      authorities: ['https://broken.example.test'],
      caFile: ca,
      http,
    });
    expect(none.status).toBe('failed');
  });

  it('is skipped without an authority', async () => {
    const db = await setup();
    expect(await anchor(db, { date: '2026-02-02', authorities: [] })).toMatchObject({
      status: 'skipped',
    });
  });
});
