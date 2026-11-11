import { beforeAll, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { claimScanStmt } from './repo-scans.ts';
import { readScannerScope } from './repo-scope.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { codeOf, key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Pending gate claim', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

it('claims only under the original actor, scalar CSRF and credential-keyset guard', async () => {
  const pass = await kit.scanPass(templateId);
  const device = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, device.id);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!row || !candidate || !row.csrfSecret) throw new Error('Missing scanner or candidate');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
  );
  const csrf = await actorCsrfFence(kit.ctx, actor);
  if (!csrf) throw new Error('Missing scanner CSRF fence');
  const authority = actorAuthorityPredicate({
    actor,
    now: kit.clock.now(),
    event: null,
    templateId,
    adminEventTemplates: false,
  });
  const guard = (commitment: string) => ({
    sql: `(${authority.sql}) AND (${csrf.sql}) AND
      (NOT EXISTS (SELECT 1 FROM credential_ref_keyset) OR (${credentialRefKeysetSql}))
      AND ${Array(100).fill('?=1').join(' AND ')}`,
    params: [...authority.params, ...csrf.params, commitment, ...Array(100).fill(1)],
  });
  const claim = () => {
    const now = kit.clock.now();
    return {
      id: kit.fx.ids.id(),
      orgId: actor.orgId,
      mode: actor.mode,
      scannerId: device.id,
      eventId: null,
      actorType: 'scanner' as const,
      actorId: device.id,
      actorKey: actor.actorKey,
      staffId: null,
      idempotencyKey: key(),
      requestHash: 'guarded-claim',
      method: 'manual',
      clientTs: now,
      now,
    };
  };
  const captured: { sql: string; values: unknown[] }[] = [];
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  captured.push({ sql, values });
                  return statement.bind(...values);
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const accepted = claim();
  expect(
    (await claimScanStmt(db, accepted, guard(candidate.credentialKeysetCommitment)).all()).results,
  ).toHaveLength(1);
  const bound = captured[0];
  if (!bound) throw new Error('Missing claim SQL');
  expect(bound.values.length).toBeLessThan(100);
  const slots = scanSecretSlots(bound.sql, bound.values.length);
  if (!slots) throw new Error('Malformed guarded claim');
  bound.values.forEach((value, index) => {
    if (typeof value === 'string' && value.includes(row.csrfSecret!))
      expect(slots[index]?.label).toBe('csrf:actor:scanner');
  });
  const badKeyset = `${candidate.credentialKeysetCommitment[0] === '0' ? '1' : '0'}${candidate.credentialKeysetCommitment.slice(1)}`;
  const wrongKey = claim();
  expect((await claimScanStmt(kit.env.DB, wrongKey, guard(badKeyset)).all()).results).toHaveLength(
    0,
  );
  expect(await first(kit.env.DB, 'SELECT id FROM scans WHERE id=?', [wrongKey.id])).toBeNull();
  const malformed = claim();
  expect(
    (
      await claimScanStmt(kit.env.DB, malformed, {
        sql: '?/* scan-ephemeral-unregistered */=1',
        params: [1],
      }).all()
    ).results,
  ).toHaveLength(0);
  await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
    kit.clock.now(),
    device.id,
  ]);
  const revoked = claim();
  expect(
    (await claimScanStmt(kit.env.DB, revoked, guard(candidate.credentialKeysetCommitment)).all())
      .results,
  ).toHaveLength(0);
  expect(await first(kit.env.DB, 'SELECT id FROM scans WHERE id=?', [revoked.id])).toBeNull();
});

it.each([
  ['actor type', "UPDATE scans SET actor_type='user' WHERE id=?"],
  ['actor id', "UPDATE scans SET actor_id='changed-actor' WHERE id=?"],
  ['method', "UPDATE scans SET method='wedge' WHERE id=?"],
  ['event', "UPDATE scans SET event_id='changed-event' WHERE id=?"],
  ['request hash', "UPDATE scans SET request_hash='changed-hash' WHERE id=?"],
])('rejects a changed pending claim %s before the gate transaction', async (_field, change) => {
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const idempotencyKey = key();
  const real = kit.env.DB;
  const gateStatements = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('INSERT INTO scan_gates')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  gateStatements.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => gateStatements.has(statement))) {
            fired = true;
            const claim = await first<{ id: string }>(
              real,
              'SELECT id FROM scans WHERE idempotency_key=?',
              [idempotencyKey],
            );
            if (!claim) throw new Error('Missing pending claim');
            await run(real, change, [claim.id]);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const response = await kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(fired).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
  } finally {
    Object.assign(kit.env, { DB: real });
  }
  expect(
    await first(real, 'SELECT state,reason,pass_id FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]),
  ).toEqual({ state: 'failed', reason: 'stale', pass_id: null });
  expect(await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(0);
  expect(await all(real, 'SELECT * FROM scan_presence WHERE pass_id=?', [pass.id])).toHaveLength(0);
  expect(
    await all(real, "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
  ).toHaveLength(0);
});

it('rejects a changed pending claim before a held-gate result is finalized', async () => {
  const once = await kit.scanTemplate('Held claim', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
  });
  const pass = await kit.scanPass(once);
  const scanner = await kit.scanner({ templateIds: [once] });
  const request = (idempotencyKey: string) =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
  expect((await request(key())).status).toBe(200);
  const real = kit.env.DB;
  const originalGate = await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id]);
  const originalEvents = await all(
    real,
    "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
    [pass.id],
  );
  const idempotencyKey = key();
  const finalizes = new WeakSet<D1PreparedStatement>();
  let batches = 0;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes("UPDATE scans SET state = 'done'")) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  finalizes.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => finalizes.has(statement)) && ++batches === 2)
            await run(real, "UPDATE scans SET method='wedge' WHERE idempotency_key=?", [
              idempotencyKey,
            ]);
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const response = await request(idempotencyKey);
    expect(batches).toBe(2);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
  } finally {
    Object.assign(kit.env, { DB: real });
  }
  expect(
    await first(real, 'SELECT state,reason,pass_id FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]),
  ).toEqual({ state: 'failed', reason: 'stale', pass_id: null });
  expect(await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual(
    originalGate,
  );
  expect(
    await all(real, "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
  ).toEqual(originalEvents);
});
