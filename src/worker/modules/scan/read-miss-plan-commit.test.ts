import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { auditStmt } from '../audit/repo.ts';
import { isReadMissStale, prepareReadMiss } from './misses.ts';
import { fixture, kit, setupReadMissPlan, templateId } from './read-miss-plan-test-fixtures.ts';
import { type ReadMissFence, readMissAuthorityPredicate } from './repo-miss-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';

beforeAll(setupReadMissPlan);

describe('batched read-miss authority', () => {
  it('rolls back a same-batch change to an observed candidate snapshot', async () => {
    const f = await fixture();
    const pass = await kit.scanPass(templateId);
    const assertion = {
      sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */
        AND p.external_id IS ?/* scan-ephemeral-external-id */)`,
      params: [pass.id, pass.externalId],
    };
    const plan = prepareReadMiss(kit.ctx, f.actor, { ...f.fence, assertions: [assertion] });
    const error = await kit.env.DB.batch([
      stmt(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', ['changed-in-batch', pass.id]),
      ...plan.stmts,
    ]).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(isReadMissStale(error)).toBe(true);
    expect(await first(kit.env.DB, 'SELECT external_id FROM passes WHERE id=?', [pass.id])).toEqual(
      { external_id: pass.externalId },
    );
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('rejects a keyset replacement and does not count a mismatched captured keyset', async () => {
    const f = await fixture();
    const original = f.credentials.credentialKeysetCommitment;
    const replacement = original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const current = prepareReadMiss(kit.ctx, f.actor, f.fence);
    await expect(
      kit.env.DB.batch([
        stmt(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [replacement]),
        ...current.stmts,
      ]),
    ).rejects.toThrow('credential reference keyset is immutable');
    expect(
      await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
    ).toEqual({ commitment: original });
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });

    // Model a different original capture without mutating the immutable database keyset.
    // Both actor and input agree on the capture, so only the final database CAS denies it.
    const actor = { ...f.actor, credentialKeysetCommitment: replacement };
    const fence: ReadMissFence = {
      ...f.fence,
      credentials: { ...f.credentials, credentialKeysetCommitment: replacement },
    };
    const predicate = readMissAuthorityPredicate(actor, kit.clock.now(), fence);
    expect(predicate.sql).not.toBe('0');
    const plan = prepareReadMiss(kit.ctx, actor, fence);
    const results = await kit.env.DB.batch([
      outputPredicateStmt(kit.env.DB, predicate),
      ...plan.stmts,
    ]);
    expect(results[0]?.results?.[0]).toEqual({ authorized: 0 });
    expect(plan.result(results.slice(1))).toBe('not_committed');
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('does not count when an original credential is retired in the final batch', async () => {
    const f = await fixture();
    const plan = prepareReadMiss(kit.ctx, f.actor, f.fence);
    const pass = await kit.scanPass(templateId);
    const transferId = kit.fx.ids.id();
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: transferId,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    const results = await kit.env.DB.batch([
      stmt(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
        (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
        SELECT pass_id,org_id,mode,source_generation,'lookup',?,? FROM pass_credential_transfers WHERE id=?`,
        [f.credentials.credentialTombstoneRefs[0]!, kit.clock.now(), transferId],
      ),
      ...plan.stmts,
    ]);
    expect(results[0]?.meta.changes).toBe(1);
    expect(plan.result(results.slice(1))).toBe('not_committed');
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('checks original credential references only in the actor mode', async () => {
    const f = await fixture();
    const pass = await kit.scanPass(templateId, {}, { mode: 'test' });
    const transferId = kit.fx.ids.id();
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: transferId,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
    });
    const ref = f.credentials.credentialTombstoneRefs[0];
    if (!ref) throw new Error('Missing original credential reference');
    await run(
      kit.env.DB,
      `INSERT INTO pass_credential_tombstones
      (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
      SELECT pass_id,org_id,mode,source_generation,'lookup',?,? FROM pass_credential_transfers WHERE id=?`,
      [ref, kit.clock.now(), transferId],
    );
    const plan = prepareReadMiss(kit.ctx, f.actor, f.fence);
    expect(plan.result(await kit.env.DB.batch(plan.stmts))).toBe('counted');
    expect(await f.counter()).toEqual({ count: 1 });
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('rolls back the caller audit and increment if the cap audit is suppressed', async () => {
    const f = await fixture();
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      f.key,
      f.window,
    ]);
    const plan = prepareReadMiss(kit.ctx, f.actor, f.fence);
    await run(
      kit.env.DB,
      `CREATE TRIGGER read_miss_plan_suppress_cap BEFORE INSERT ON audit_log
      WHEN NEW.action='scan.misses_capped' BEGIN SELECT RAISE(IGNORE); END`,
    );
    try {
      const callerAudit = auditStmt(kit.env.DB, kit.ctx, {
        orgId: f.actor.orgId,
        actorType: f.actor.actor.type,
        actorId: f.actor.actor.id,
        action: 'scan.lookup',
        detail: { count: 0 },
      });
      await expect(kit.env.DB.batch([callerAudit, ...plan.stmts])).rejects.toThrow();
      expect(await f.counter()).toEqual({ count: 30 });
      expect(await f.auditCount()).toEqual({ count: 0 });
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM audit_log WHERE action='scan.lookup' AND actor_id=?",
          [f.scanner.id],
        ),
      ).toBeNull();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER read_miss_plan_suppress_cap');
    }
  });
});
