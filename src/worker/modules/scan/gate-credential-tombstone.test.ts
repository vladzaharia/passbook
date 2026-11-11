import { beforeAll, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';
import {
  codeOf,
  key,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Credential tombstone gate', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

it('keeps keyed refs in scalar binds and checks the keyset even for an empty selector', () => {
  const refs = ['a'.repeat(64), 'b'.repeat(64)];
  const keyset = 'c'.repeat(64);
  const predicate = noCredentialTombstonesSql(refs, { orgIdSql: '?', modeSql: '?' }, keyset);
  const packed = packScanPredicate(
    predicate.sql,
    [kit.org.id, 'live', ...predicate.params],
    'tombstone_bound',
  );
  if (!packed) throw new Error('Unable to pack tombstone predicate');
  expect(packed.params[0]).not.toContain(refs[0]);
  expect(packed.params[0]).not.toContain(refs[1]);
  expect(packed.params.slice(1)).toEqual([JSON.stringify(refs)]);
  expect(scanSecretSlots(packed.sql, packed.params.length)?.map((slot) => slot.label)).toEqual([
    null,
    'credential-refs',
  ]);
  const empty = noCredentialTombstonesSql([], { orgIdSql: '?', modeSql: '?' }, keyset);
  expect(empty.sql).not.toBe('0');
  expect(empty.params).toEqual([keyset]);
});

async function tombstone(db: D1Database, other: Pass, code: string, ref: string) {
  // Retire an overlapping barcode through the real transfer boundary, not an unowned tombstone.
  await run(db, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
    await barcodeHashOfCode(cleanCode(code)),
    other.id,
  ]);
  expect((await startScanCredentialTransfer(kit, other.id, { db })).state).toBe('completed');
  expect(
    await first(
      db,
      `SELECT credential_hash FROM pass_credential_tombstones
    WHERE pass_id=? AND credential_hash=?`,
      [other.id, ref],
    ),
  ).not.toBeNull();
}

async function race<T>(
  stage: 'gate' | 'output',
  change: (db: D1Database) => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  const matches = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          const selected =
            stage === 'gate'
              ? sql.includes('INSERT INTO scan_gates')
              : sql.includes('AS authorized') && sql.includes('scan_retention_proofs');
          if (!selected) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  matches.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => matches.has(statement))) {
            fired = true;
            await change(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const value = await work();
    expect(fired).toBe(true);
    return value;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

it('rejects a cross-pass retired credential introduced after preflight', async () => {
  const pass = await kit.scanPass(templateId);
  const other = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const input = codeOf(pass);
  const refs = await credentialTombstoneRefsForInput(kit.ctx, pass.orgId, pass.mode, input, false);
  const ref = refs.credentialTombstoneRefs[0];
  if (!ref) throw new Error('Missing credential reference');
  const idempotencyKey = key();
  const response = await race(
    'gate',
    (db) => tombstone(db, other, input.code, ref),
    () =>
      kit.post(scanner.headers, '/actions', {
        input,
        idempotencyKey,
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
  expect(
    await first(kit.env.DB, 'SELECT state,reason,pass_id FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]),
  ).toEqual({ state: 'failed', reason: 'stale', pass_id: null });
  expect(await all(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
    0,
  );
  expect(
    await all(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id=?', [pass.id]),
  ).toHaveLength(0);
  expect(
    await all(kit.env.DB, "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
      pass.id,
    ]),
  ).toHaveLength(0);
});

it('withholds a committed credential scan if the presented credential retires before output', async () => {
  const pass = await kit.scanPass(templateId);
  const other = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const input = codeOf(pass);
  const refs = await credentialTombstoneRefsForInput(kit.ctx, pass.orgId, pass.mode, input, false);
  const ref = refs.credentialTombstoneRefs[0];
  if (!ref) throw new Error('Missing credential reference');
  const response = await race(
    'output',
    (db) => tombstone(db, other, input.code, ref),
    () =>
      kit.post(scanner.headers, '/actions', {
        input,
        idempotencyKey: key(),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SCAN_UNCONFIRMED' });
  expect(await all(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
    1,
  );
});

it('does not apply presented-credential tombstones to an authorized direct passId selector', async () => {
  const pass = await kit.scanPass(templateId);
  const other = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const refs = await credentialTombstoneRefsForInput(
    kit.ctx,
    pass.orgId,
    pass.mode,
    codeOf(pass),
    false,
  );
  const ref = refs.credentialTombstoneRefs[0];
  if (!ref) throw new Error('Missing credential reference');
  await tombstone(kit.env.DB, other, codeOf(pass).code, ref);
  const response = await kit.post(scanner.headers, '/actions', {
    input: { passId: pass.id, method: 'manual' },
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'ok' });
});
