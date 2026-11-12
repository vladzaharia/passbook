import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { auditStmt } from '../audit/repo.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { countMiss, isReadMissStale, prepareReadMiss } from './misses.ts';
import { fixture, kit, setupReadMissPlan, templateId } from './read-miss-plan-test-fixtures.ts';
import { type ReadMissFence, readMissAuthorityPredicate } from './repo-miss-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';

beforeAll(setupReadMissPlan);

describe('batched read-miss authority', () => {
  it('retains the original CSRF as a labeled scalar and rejects missing evidence', async () => {
    const f = await fixture();
    const predicate = readMissAuthorityPredicate(f.actor, kit.clock.now(), f.fence);
    const slots = scanSecretSlots(predicate.sql, predicate.params.length);
    if (!slots) throw new Error('Malformed bound miss authority');
    const index = slots.findIndex((slot) => slot.label === 'csrf:actor:scanner');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(predicate.params[index]).toBe(f.csrfSecret);
    const input = slots.findIndex((slot) => slot.label === 'external-id');
    expect(input).toBeGreaterThanOrEqual(0);
    expect(predicate.params[input]).toBe(f.query);
    for (const [at, slot] of slots.entries()) {
      if (slot.label === null) {
        expect(String(predicate.params[at])).not.toContain(f.csrfSecret);
        expect(String(predicate.params[at])).not.toContain(f.query);
      }
    }
    const other = await fixture();
    const differentKeyset =
      f.credentials.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const invalid: ReadMissFence[] = [
      { ...f.fence, csrf: { sql: '1', params: [] } },
      { ...f.fence, csrf: other.fence.csrf },
      { ...f.fence, credentials: null },
      {
        ...f.fence,
        credentials: { ...f.credentials, credentialKeysetCommitment: differentKeyset },
      },
      { ...f.fence, credentials: { ...f.credentials, credentialTombstoneRefs: ['not-a-ref'] } },
    ];
    for (const fence of invalid) {
      const plan = prepareReadMiss(kit.ctx, f.actor, fence);
      expect(plan.result(await kit.env.DB.batch(plan.stmts))).toBe('not_committed');
    }
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('keeps standalone no-input counting usable with an actor keyset', async () => {
    const f = await fixture();
    await countMiss(kit.ctx, f.actor);
    expect(await f.counter()).toEqual({ count: 1 });
  });

  it('uses the same final item predicates as the response', async () => {
    const f = await fixture();
    const visible = {
      sql: "EXISTS (SELECT 1 FROM orgs WHERE id=? AND status='active')",
      params: [f.actor.orgId],
    };
    const plan = prepareReadMiss(kit.ctx, f.actor, { ...f.fence, visible: [visible] });
    const results = await kit.env.DB.batch([
      outputPredicateStmt(kit.env.DB, visible),
      ...plan.stmts,
      stmt(kit.env.DB, 'SELECT 2 AS marker'),
    ]);
    expect(results[0]?.results?.[0]).toEqual({ authorized: 1 });
    expect(results[results.length - 1]?.results?.[0]).toEqual({ marker: 2 });
    expect(plan.result(results.slice(1, 1 + plan.stmts.length))).toBe('not_committed');
    expect(await f.counter()).toBeNull();

    // A miss is eligible only if every final predicate is false or NULL.
    const hidden = {
      sql: "EXISTS (SELECT 1 FROM orgs WHERE id=? AND status='suspended')",
      params: [f.actor.orgId],
    };
    const mixed = prepareReadMiss(kit.ctx, f.actor, { ...f.fence, visible: [hidden, visible] });
    expect(mixed.result(await kit.env.DB.batch(mixed.stmts))).toBe('not_committed');
    expect(await f.counter()).toBeNull();
    const miss = prepareReadMiss(kit.ctx, f.actor, {
      ...f.fence,
      visible: [hidden, { sql: 'NULL', params: [] }],
    });
    const final = await kit.env.DB.batch([outputPredicateStmt(kit.env.DB, hidden), ...miss.stmts]);
    expect(final[0]?.results?.[0]).toEqual({ authorized: 0 });
    expect(miss.result(final.slice(1))).toBe('counted');
    expect(await f.counter()).toEqual({ count: 1 });
  });

  it('counts a current hidden candidate but not a matching pending transfer', async () => {
    const f = await fixture();
    const pass = await kit.scanPass(templateId);
    const credentials = await credentialTombstoneRefsForInput(
      kit.ctx,
      f.actor.orgId,
      f.actor.mode,
      { passId: pass.id, method: 'manual' },
      true,
      'defer',
    );
    const candidates = {
      sql: `(SELECT COUNT(*) FROM passes p WHERE p.org_id=? AND p.mode=?
        AND p.id=?/* scan-ephemeral-pass-id */)<>1
        OR EXISTS (SELECT 1 FROM pass_credential_transfers t
          WHERE t.pass_id=?/* scan-ephemeral-pass-id */ AND t.state='pending')`,
      params: [f.actor.orgId, f.actor.mode, pass.id, pass.id],
    };
    const assertion = {
      sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */
        AND p.external_id IS ?/* scan-ephemeral-external-id */)`,
      params: [pass.id, pass.externalId],
    };
    const fence: ReadMissFence = {
      ...f.fence,
      credentials,
      candidates,
      assertions: [assertion],
      visible: [{ sql: '0', params: [] }],
    };
    const hidden = prepareReadMiss(kit.ctx, f.actor, fence);
    expect(hidden.result(await kit.env.DB.batch(hidden.stmts))).toBe('counted');
    expect(await f.counter()).toEqual({ count: 1 });

    await run(kit.env.DB, 'UPDATE counters SET count=30 WHERE key=? AND window_start=?', [
      f.key,
      f.window,
    ]);
    const capped = prepareReadMiss(kit.ctx, f.actor, fence);
    expect(capped.result(await kit.env.DB.batch(capped.stmts))).toBe('capped');
    const audit = await first(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
      [f.scanner.id],
    );
    expect(audit).toMatchObject({ detail: null });
    for (const secret of [pass.id, pass.serial, pass.scanCode, f.csrfSecret]) {
      if (secret) {
        expect(JSON.stringify(audit)).not.toContain(secret);
        expect(f.key).not.toContain(secret);
      }
    }

    const pending = prepareReadMiss(kit.ctx, f.actor, fence);
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: kit.fx.ids.id(),
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    expect(pending.result(await kit.env.DB.batch(pending.stmts))).toBe('not_committed');
    expect(await f.counter()).toEqual({ count: 31 });
    expect(await f.auditCount()).toEqual({ count: 1 });
  });

  it('rejects a same-sized replacement of the original candidate window', async () => {
    const f = await fixture();
    const firstPass = await kit.scanPass(templateId);
    const secondPass = await kit.scanPass(templateId);
    const replacement = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id IN (?,?)', [
      f.query,
      firstPass.id,
      secondPass.id,
    ]);
    const candidates = {
      sql: `(SELECT COUNT(*) FROM passes p WHERE p.org_id=? AND p.mode=?
        AND p.external_id=?/* scan-ephemeral-external-id */)<>2
        OR EXISTS (SELECT 1 FROM passes p JOIN pass_credential_transfers t ON t.pass_id=p.id
          WHERE p.org_id=? AND p.mode=? AND p.external_id=?/* scan-ephemeral-external-id */
            AND t.state='pending')`,
      params: [f.actor.orgId, f.actor.mode, f.query, f.actor.orgId, f.actor.mode, f.query],
    };
    const assertions = [firstPass, secondPass].map((pass) => ({
      sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */
        AND p.external_id=?/* scan-ephemeral-external-id */)`,
      params: [pass.id, f.query],
    }));
    const fence = { ...f.fence, candidates, assertions };
    const current = prepareReadMiss(kit.ctx, f.actor, fence);
    expect(current.result(await kit.env.DB.batch(current.stmts))).toBe('counted');

    const stale = prepareReadMiss(kit.ctx, f.actor, fence);
    const error = await kit.env.DB.batch([
      stmt(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=? RETURNING 1', [
        'no-longer-matching',
        firstPass.id,
      ]),
      stmt(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=? RETURNING 1', [
        f.query,
        replacement.id,
      ]),
      ...stale.stmts,
    ]).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(isReadMissStale(error)).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT external_id FROM passes WHERE id=?', [firstPass.id]),
    ).toEqual({ external_id: f.query });
    expect(
      await first(kit.env.DB, 'SELECT external_id FROM passes WHERE id=?', [replacement.id]),
    ).toEqual({ external_id: replacement.externalId });
    expect(await f.counter()).toEqual({ count: 1 });
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('suppresses a miss when a matching pass appears in the same batch', async () => {
    const f = await fixture();
    const pass = await kit.scanPass(templateId);
    const plan = prepareReadMiss(kit.ctx, f.actor, f.fence);
    const results = await kit.env.DB.batch([
      stmt(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=? RETURNING 1', [
        f.query,
        pass.id,
      ]),
      ...plan.stmts,
    ]);
    expect(results[0]?.results).toHaveLength(1);
    expect(plan.result(results.slice(1))).toBe('not_committed');
    expect(await f.counter()).toBeNull();
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('checks separately bound snapshots atomically and slices past their results', async () => {
    const f = await fixture();
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,30)', [
      f.key,
      f.window,
    ]);
    const current = {
      sql: '?/* scan-ephemeral-external-id */=?/* scan-ephemeral-external-id */',
      params: [f.query, f.query],
    };
    const assertions = Array.from({ length: 101 }, () => current);
    const success = prepareReadMiss(kit.ctx, f.actor, { ...f.fence, assertions });
    const results = await kit.env.DB.batch([
      stmt(kit.env.DB, 'SELECT 1 AS marker'),
      ...success.stmts,
    ]);
    const status = success.result(results.slice(1));
    expect(status).toBe('capped');
    expect(success.result(results.slice(1, -1))).toBe('not_committed');
    expect(success.result(results)).toBe('not_committed');
    expect(() => success.throwIfCapped(status)).toThrow('Too many codes not found.');
    expect(await f.counter()).toEqual({ count: 31 });
    expect(await f.auditCount()).toEqual({ count: 1 });
    const audit = await first(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
      [f.scanner.id],
    );
    expect(audit).toMatchObject({ detail: null });
    expect(JSON.stringify(audit)).not.toContain(f.csrfSecret);
    expect(JSON.stringify(audit)).not.toContain(f.query);

    const stale = prepareReadMiss(kit.ctx, f.actor, {
      ...f.fence,
      assertions: [current, { sql: '0', params: [] }],
    });
    const callerAudit = auditStmt(kit.env.DB, kit.ctx, {
      orgId: f.actor.orgId,
      actorType: f.actor.actor.type,
      actorId: f.actor.actor.id,
      action: 'scan.lookup',
      detail: { count: 0 },
    });
    const error = await kit.env.DB.batch([callerAudit, ...stale.stmts]).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(isReadMissStale(error)).toBe(true);
    expect(isReadMissStale(new Error('unrelated failure'))).toBe(false);
    expect(await f.counter()).toEqual({ count: 31 });
    expect(await f.auditCount()).toEqual({ count: 1 });
    expect(
      await first(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE action='scan.lookup' AND actor_id=?",
        [f.scanner.id],
      ),
    ).toBeNull();
  });
});
