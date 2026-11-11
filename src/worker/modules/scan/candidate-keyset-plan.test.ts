import { expect, it, vi } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import { scannerActor, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput, scanCredentialKeys } from './credential-input.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { getScanner } from './repo-device.ts';
import {
  byBarcodeHashStmt,
  byIdStmt,
  byLookupHashStmt,
  byScanCodeStmt,
  bySerialStmt,
} from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  searchInputWindowChangedPredicate,
  searchObservedCandidatePredicate,
  searchPassesStmt,
  searchRowsOf,
} from './repo-search.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import { makeLegacyScanPass, proofedScanActor, setupScanKit } from './test-kit.ts';

async function fixture(expiresIn?: number) {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Candidate keyset plan', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const scanner = await kit.scanner({
    templateIds: [templateId],
    ...(expiresIn === undefined ? {} : { expiresAt: kit.clock.now() + expiresIn }),
  });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner authority');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
    { keysetPolicy: 'defer' },
  );
  const input = { passId: pass.id, method: 'manual' as const };
  const refs = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    input,
    true,
    'defer',
  );
  return { kit, scanner, pass, template, actor, input, refs };
}

it('bootstraps the original keyset and candidate in the actor-fenced batch', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  const candidates = plan.finish(await kit.env.DB.batch(plan.stmts));
  expect(candidates).toMatchObject([
    {
      pass: { id: pass.id },
      credentialKeysetCommitment: refs.credentialKeysetCommitment,
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    },
  ]);
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toEqual({ commitment: refs.credentialKeysetCommitment });
});

it('packs a large initialization guard without exceeding the D1 bind limit', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  let maxBindings = 0;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  maxBindings = Math.max(maxBindings, values.length);
                  return statement.bind(...values);
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const clauses = Array.from({ length: 80 }, () => '? IS ?');
  const params = Array.from({ length: 80 }, (_, index) => [index, index]).flat();
  const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: db } };
  const plan = await planCandidateReads(ctx, actor, input, refs, () => ({
    sql: clauses.join(' AND '),
    params,
  }));
  expect(maxBindings).toBeLessThan(100);
  expect(plan.finish(await db.batch(plan.stmts))).toMatchObject([{ pass: { id: pass.id } }]);
});

it('does not initialize when a guard cannot be safely packed', async () => {
  const { kit, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs, () => ({
    sql: '? IS ?',
    params: [Number.NaN, Number.NaN],
  }));
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it('labels each raw candidate lookup value as a scalar bind', async () => {
  const { kit, pass, actor } = await fixture();
  const labels: string[] = [];
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const slots = scanSecretSlots(sql, values.length);
                  if (!slots) throw new Error('Unrecognized candidate bind layout');
                  labels.push(
                    ...slots.flatMap((slot) => (slot.label === null ? [] : [slot.label])),
                  );
                  return statement.bind(...values);
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  byIdStmt(db, actor.orgId, pass.id);
  byScanCodeStmt(db, actor.orgId, 'A'.repeat(26), actor.mode);
  byBarcodeHashStmt(db, actor.orgId, 'b'.repeat(64), actor.mode);
  byLookupHashStmt(db, actor.orgId, 'c'.repeat(64), actor.mode);
  bySerialStmt(db, actor.orgId, pass.serial, actor.mode);
  expect(labels).toEqual(['pass-id', 'scan-code', 'barcode-hash', 'lookup-hash', 'serial']);
});

it('reads the first scoped search page in the same bootstrap batch', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  expect(keys.credentialKeysetCommitment).toBe(refs.credentialKeysetCommitment);
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  const query = searchPassesStmt(
    kit.env.DB,
    actor,
    pass.id,
    null,
    keys,
    kit.clock.now(),
    0,
    keys.credentialTombstoneRefs,
    keys.credentialKeysetCommitment,
  );
  if (!query) throw new Error('Missing scoped search query');
  const results = await kit.env.DB.batch([...plan.stmts, query]);
  expect(plan.finish(results.slice(0, plan.stmts.length))).toMatchObject([
    { pass: { id: pass.id } },
  ]);
  expect(searchRowsOf(results[plan.stmts.length])).toEqual([
    { id: pass.id, last_scan_at: null, last_scan_id: null },
  ]);
});

it('rechecks a same-mode observed input match, including a pending transfer', async () => {
  const { kit, pass, actor } = await fixture();
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  const predicate = searchObservedCandidatePredicate(actor, pass.id, null, keys, pass.id);
  const slots = scanSecretSlots(predicate.sql, predicate.params.length);
  expect(slots?.filter((slot) => slot.label !== null)).toHaveLength(9);
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS matches`,
      predicate.params,
    ),
  ).toEqual({ matches: 1 });
  const wrongMode = searchObservedCandidatePredicate(
    { ...actor, mode: 'test' },
    pass.id,
    null,
    keys,
    pass.id,
  );
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${wrongMode.sql}) THEN 1 ELSE 0 END AS matches`,
      wrongMode.params,
    ),
  ).toEqual({ matches: 0 });
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: kit.fx.ids.id(),
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS matches`,
      predicate.params,
    ),
  ).toEqual({ matches: 1 });
});

it('escapes name prefixes in the shared search and miss match', async () => {
  const { kit, pass, actor } = await fixture();
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha% literal',
    pass.id,
  ]);
  const match = searchObservedCandidatePredicate(actor, 'Alpha%', null, undefined, pass.id);
  const nonmatch = searchObservedCandidatePredicate(actor, 'Alpha_', null, undefined, pass.id);
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${match.sql}) THEN 1 ELSE 0 END AS matches`,
      match.params,
    ),
  ).toEqual({ matches: 1 });
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${nonmatch.sql}) THEN 1 ELSE 0 END AS matches`,
      nonmatch.params,
    ),
  ).toEqual({ matches: 0 });
  expect(searchObservedCandidatePredicate(actor, 'a@', null, undefined, pass.id)).toEqual({
    sql: '0',
    params: [],
  });
});

it('fences a hidden-only search window and detects pending matching transfers', async () => {
  const { kit, pass, template, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toHaveLength(1);
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha original',
    pass.id,
  ]);
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, 'Alpha', false);
  const changed = searchInputWindowChangedPredicate(
    actor,
    'Alpha',
    null,
    keys,
    kit.clock.now(),
    keys.credentialTombstoneRefs,
    keys.credentialKeysetCommitment,
    1,
  );
  const observed = searchObservedCandidatePredicate(actor, 'Alpha', null, keys, pass.id);
  expect(scanSecretSlots(changed.sql, changed.params.length)).not.toBeNull();
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${changed.sql}) THEN 1 ELSE 0 END AS changed`,
      changed.params,
    ),
  ).toEqual({ changed: 0 });
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${observed.sql}) THEN 1 ELSE 0 END AS matches`,
      observed.params,
    ),
  ).toEqual({ matches: 1 });

  const replacement = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha replacement',
    replacement.id,
  ]);
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${changed.sql}) THEN 1 ELSE 0 END AS changed`,
      changed.params,
    ),
  ).toEqual({ changed: 1 });
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', ['Not matched', pass.id]);
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${changed.sql}) THEN 1 ELSE 0 END AS changed`,
      changed.params,
    ),
  ).toEqual({ changed: 0 });
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${observed.sql}) THEN 1 ELSE 0 END AS matches`,
      observed.params,
    ),
  ).toEqual({ matches: 0 });

  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha original',
    pass.id,
  ]);
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Not matched',
    replacement.id,
  ]);
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: kit.fx.ids.id(),
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  expect(
    await first(
      kit.env.DB,
      `SELECT CASE WHEN (${changed.sql}) THEN 1 ELSE 0 END AS changed`,
      changed.params,
    ),
  ).toEqual({ changed: 1 });
});

it('selects a deterministic latest scan within the same organization and mode', async () => {
  const { kit, scanner, pass, template, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toHaveLength(1);
  const at = kit.clock.now();
  for (const [id, mode, state, timestamp] of [
    ['scan-a', 'live', 'done', at],
    ['scan-b', 'live', 'done', at],
    ['scan-older', 'live', 'done', at - 1],
    ['scan-other-mode', 'test', 'done', at + 1],
    ['scan-pending', 'live', 'pending', at + 2],
  ] as const) {
    await run(
      kit.env.DB,
      `INSERT INTO scans
      (id,org_id,mode,pass_id,template_id,actor_type,actor_id,actor_key,
        idempotency_key,request_hash,method,state,at)
      VALUES (?,?,?,?,?,'scanner',?,?,?,?,'manual',?,?)`,
      [
        id,
        actor.orgId,
        mode,
        pass.id,
        template.id,
        scanner.id,
        actor.actorKey,
        id,
        id,
        state,
        timestamp,
      ],
    );
  }
  const countPlan = await planCandidateReads(kit.ctx, actor, input, refs, null);
  if (!countPlan.capacityStmt) throw new Error('Missing history capacity statement');
  const countResults = await kit.env.DB.batch([...countPlan.stmts, countPlan.capacityStmt]);
  expect(countPlan.finish(countResults.slice(0, countPlan.stmts.length))).toHaveLength(1);
  expect(countResults[countPlan.stmts.length]?.results).toEqual([{ id: pass.id, n: 4 }]);
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  const query = searchPassesStmt(
    kit.env.DB,
    actor,
    pass.id,
    null,
    keys,
    at,
    0,
    keys.credentialTombstoneRefs,
    keys.credentialKeysetCommitment,
  );
  if (!query) throw new Error('Missing scoped search query');
  expect(searchRowsOf(await query.all())).toEqual([
    { id: pass.id, last_scan_at: at, last_scan_id: 'scan-b' },
  ]);
});

it('does not bootstrap after the original actor loses authority', async () => {
  const { kit, scanner, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.stmts.length).toBeGreaterThan(0);
  await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
    kit.clock.now(),
    scanner.id,
  ]);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it.each(['default', 'claim'] as const)(
  'does not bootstrap or return credentials when the original actor expires during hashing (%s)',
  async (kind) => {
    const { kit, pass, actor } = await fixture(1_000);
    const input = { code: pass.serial, method: 'manual' as const };
    const refs = await credentialTombstoneRefsForInput(
      kit.ctx,
      actor.orgId,
      actor.mode,
      input,
      true,
      'defer',
    );
    const expiresAt = kit.clock.now() + 1_000;
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let expiredDuringHash = false;
    let guardNow: number | undefined;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await nativeDigest(algorithm, data);
      if (!expiredDuringHash && new TextDecoder().decode(data) === input.code) {
        expiredDuringHash = true;
        kit.clock.advance(1_000);
      }
      return result;
    });
    try {
      const plan = await planCandidateReads(
        kit.ctx,
        actor,
        input,
        refs,
        kind === 'claim'
          ? (now) => {
              guardNow = now;
              return actorAuthorityPredicate({
                actor,
                now,
                event: actor.event,
                adminEventTemplates: actor.adminEventTemplates === true,
              });
            }
          : undefined,
      );
      expect(expiredDuringHash).toBe(true);
      expect(plan.now).toBe(expiresAt);
      if (kind === 'claim') expect(guardNow).toBe(expiresAt);
      expect(plan.stmts.length).toBeGreaterThan(0);
      expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          `SELECT name FROM sqlite_master
        WHERE type='trigger' AND name='credential_ref_keyset_insert_guard'`,
        ),
      ).toEqual({ name: 'credential_ref_keyset_insert_guard' });
    } finally {
      digest.mockRestore();
    }
  },
);

it('never bootstraps a read-only candidate plan', async () => {
  const { kit, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs, null);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it('does not initialize after a denied new-claim guard', async () => {
  const { kit, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs, () => ({
    sql: '0',
    params: [],
  }));
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it('does not bootstrap a missing keyset over retained credential references', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  const transferId = kit.fx.ids.id();
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: transferId,
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  const ref = await credentialTombstoneRef(
    kit.env,
    actor.orgId,
    actor.mode,
    await sha256Hex(pass.serial),
  );
  const inserted = await run(
    kit.env.DB,
    `INSERT INTO pass_credential_tombstones
    (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
    SELECT pass_id, org_id, mode, source_generation, 'serial', ?, ?
    FROM pass_credential_transfers WHERE id=?`,
    [ref, kit.clock.now(), transferId],
  );
  expect(inserted.changes).toBe(1);
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});
