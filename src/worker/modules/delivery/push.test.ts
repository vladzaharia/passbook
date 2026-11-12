import { beforeAll, describe, expect, it } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { beginTransfer, interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { create as createConnection } from '../connections/service.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { createMtlsApnsTransport } from './apns.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { dispatchOutbox } from './issuance-intent.ts';
import { handleDeadLetter, handlePushDeliver } from './jobs.ts';
import { classifyApns, TransientDeliveryError } from './push.ts';
import { devicesForPass, getOutbox } from './repo.ts';
import { insertPushOutbox } from './repo-outbox-enqueue.ts';
import { markRefreshCompleted } from './repo-outbox-refresh.ts';
import { enqueuePush, enqueueRefreshPush } from './service.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

/** A pass with three devices and one claimed-for-dispatch push row. */
async function scenario() {
  const pass = await kit.pass();
  await kit.device(pass, `dev-a-${pass.id}`, A);
  await kit.device(pass, `dev-b-${pass.id}`, B);
  await kit.device(pass, `dev-c-${pass.id}`, C);
  await enqueuePush(job(), pass.id, 'refresh');
  await kit.settle();
  const row = await first<{ id: string }>(
    kit.env.DB,
    "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
    [pass.id],
  );
  return { pass, outboxId: row?.id ?? '' };
}

const deliver = (outboxId: string) =>
  handlePushDeliver({ kind: 'push.deliver', outboxId }, kit.ctx);

async function registrations(passId: string): Promise<number> {
  return (
    (
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
        [passId],
      )
    )?.n ?? 0
  );
}

describe('classification', () => {
  it.each([
    [{ token: A, status: 200 }, 'ok'],
    [{ token: A, status: 410, reason: 'Unregistered' }, 'gone'],
    [{ token: A, status: 400, reason: 'BadDeviceToken' }, 'gone'],
    [{ token: A, status: 400, reason: 'DeviceTokenNotForTopic' }, 'gone'],
    [{ token: A, status: 429, reason: 'TooManyRequests' }, 'transient'],
    [{ token: A, status: 503 }, 'transient'],
    [{ token: A, status: 0, reason: 'NetworkError' }, 'transient'],
    [{ token: A, status: 403, reason: 'BadCertificate' }, 'cert'],
    [{ token: A, status: 400, reason: 'PayloadEmpty' }, 'rejected'],
  ] as const)('%j -> %s', (result, expected) => {
    expect(classifyApns({ ...result })).toBe(expected);
  });
});

describe('dispatch', () => {
  it('marks rows enqueued before sending and never sends one twice', async () => {
    const { outboxId } = await scenario();
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'enqueued' });
    const sent = kit.queue.sent.filter((m) => (m as { outboxId: string }).outboxId === outboxId);
    expect(sent).toEqual([{ kind: 'push.deliver', outboxId }]);
    expect(await dispatchOutbox(job())).toBe(0);
    await kit.settle();
    expect(
      kit.queue.sent.filter((m) => (m as { outboxId: string }).outboxId === outboxId),
    ).toHaveLength(1);
  });

  it('reverts to pending when the queue is down, then sends on the next tick', async () => {
    const pass = await kit.pass();
    kit.queue.fail = true;
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string; state: string }>(
      kit.env.DB,
      "SELECT id, state FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(row?.state).toBe('pending');
    kit.queue.fail = false;
    expect(await dispatchOutbox(job())).toBeGreaterThanOrEqual(1);
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('enqueued');
  });
});

describe('guarded refresh push', () => {
  async function bound(orgId = kit.org.id, mode: 'live' | 'test' = 'live') {
    const pass = await kit.pass({ orgId, mode });
    const connection = await createConnection(job(), { type: 'system', id: null }, {
      orgId,
      connectorType: 'demo',
      name: 'Refresh',
      config: { count: 1 },
      mode: 'manual',
    } as never);
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connection.id,
      'm-001',
      pass.id,
    ]);
    const row = await first<{
      version: number;
      owner_user_id: string | null;
      link_generation: number;
    }>(kit.env.DB, 'SELECT version, owner_user_id, link_generation FROM passes WHERE id = ?', [
      pass.id,
    ]);
    if (!row) throw new Error('missing pass');
    return {
      pass,
      connection,
      snapshot: {
        passId: pass.id,
        orgId,
        identityId: pass.identityId,
        mode,
        status: 'active' as const,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        passVersion: row.version,
        ownerUserId: row.owner_user_id,
        linkGeneration: row.link_generation,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
        connectionId: connection.id,
        externalRef: 'm-001',
        generation: 1,
        connectionMode: 'manual' as const,
      },
    };
  }

  it('atomically stamps and queues a valid Live refresh', async () => {
    const { pass, snapshot } = await bound();
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(true);
    await kit.settle();
    const row = await first<{ last_refreshed_at: number | null }>(
      kit.env.DB,
      'SELECT last_refreshed_at FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.last_refreshed_at).toBe(kit.clock.now());
    const outbox = await first<{ payload: string; coalesce_key: string | null }>(
      kit.env.DB,
      "SELECT payload, coalesce_key FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(JSON.parse(outbox?.payload ?? '{}')).toEqual({
      reason: 'refresh',
      identityId: pass.identityId,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
    });
    expect(outbox?.coalesce_key).toBe(
      `push:${JSON.stringify([
        pass.id,
        pass.identityId,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.templateId,
        pass.templateVersion,
        pass.releaseId,
      ])}`,
    );
  });

  it.each([
    ['version', 'UPDATE passes SET version = version + 1 WHERE id = ?', false],
    [
      'holder generation',
      'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
      false,
    ],
    ['reference', "UPDATE passes SET external_ref = 'other' WHERE id = ?", false],
    ['deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?', false],
    ['removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', false],
    ['quarantine', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', false],
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?", false],
    ['generation', 'UPDATE connections SET generation = generation + 1 WHERE id = ?', true],
    ['connection mode', "UPDATE connections SET mode = 'webhook' WHERE id = ?", true],
    ['disabled', 'UPDATE connections SET enabled = 0 WHERE id = ?', true],
  ] as const)('does not stamp or queue after %s changes', async (_label, sql, onConnection) => {
    const { pass, connection, snapshot } = await bound();
    await run(kit.env.DB, sql, [onConnection ? connection.id : pass.id]);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('stamps the exact post-publication snapshot without inserting a duplicate push', async () => {
    const { pass, snapshot } = await bound();
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    expect(await markRefreshCompleted(job(), snapshot, kit.clock.now())).toBe(false);
    expect(
      await markRefreshCompleted(
        job(),
        {
          ...snapshot,
          passVersion: snapshot.passVersion + 1,
        },
        kit.clock.now(),
      ),
    ).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT last_refreshed_at FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ last_refreshed_at: kit.clock.now() });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('allows an exact connected voided completion but not a new connected voided refresh', async () => {
    const { pass, snapshot } = await bound();
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing voided pass');
    expect(await markRefreshCompleted(job(), snapshot, kit.clock.now())).toBe(false);
    const completed = {
      ...snapshot,
      status: 'voided' as const,
      lifecycleGeneration: current.lifecycleGeneration,
    };
    expect(await enqueueRefreshPush(job(), completed)).toBe(false);
    expect(await markRefreshCompleted(job(), completed, kit.clock.now())).toBe(true);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('rejects release binding drift before either stamp or outbox insertion', async () => {
    const { pass, snapshot } = await bound();
    expect(pass.releaseId).not.toBeNull();
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(await markRefreshCompleted(job(), snapshot, kit.clock.now())).toBe(false);
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('rejects missing or malformed captured identity and epochs without mutation', async () => {
    const { pass, snapshot } = await bound();
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    for (const invalid of [
      { identityId: undefined },
      { templateId: undefined },
      { templateVersion: undefined },
      { releaseId: undefined },
      { connectionMode: undefined },
      { connectionMode: null },
      { connectionMode: 'poll' },
      { templateId: 'other-template' },
      { templateVersion: 'other-version' },
      { releaseId: 'other-release' },
      { credentialKeysetCommitment: undefined },
      { credentialKeysetCommitment: 'invalid' },
      {
        credentialKeysetCommitment:
          snapshot.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
      },
      { credentialGeneration: undefined },
      { lifecycleGeneration: undefined },
      { credentialGeneration: 0 },
      { credentialGeneration: 1.5 },
      { lifecycleGeneration: -1 },
      { identityId: 'different-identity' },
    ]) {
      expect(await enqueueRefreshPush(job(), { ...snapshot, ...invalid } as never)).toBe(false);
      expect(
        await markRefreshCompleted(job(), { ...snapshot, ...invalid } as never, kit.clock.now()),
      ).toBe(false);
    }
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('does not refresh after removal and restoration return to the same visible state', async () => {
    const { pass, snapshot } = await bound();
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [pass.id]);
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing restored pass');
    expect(current.lifecycleGeneration).toBeGreaterThan(snapshot.lifecycleGeneration);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(false);
    expect(await markRefreshCompleted(job(), snapshot, kit.clock.now())).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('does not adopt a completed transfer generation for an old refresh', async () => {
    const pass = await kit.pass();
    expect((await beginTransfer(kit, pass)).state).toBe('completed');
    await kit.settle();
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing transferred pass');
    expect(current.credentialGeneration).toBeGreaterThan(pass.credentialGeneration);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    const snapshot = {
      passId: current.id,
      orgId: current.orgId,
      identityId: current.identityId,
      mode: current.mode,
      templateId: current.templateId,
      templateVersion: current.templateVersion,
      releaseId: current.releaseId,
      credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
      passVersion: current.version,
      status: current.status,
      ownerUserId: current.ownerUserId,
      linkGeneration: current.linkGeneration,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: current.lifecycleGeneration,
      connectionId: current.connectionId,
      externalRef: current.externalRef,
      generation: null,
      connectionMode: null,
    };
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(false);
    expect(await markRefreshCompleted(job(), snapshot, kit.clock.now())).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual(outbox);
    expect(
      await enqueueRefreshPush(job(), {
        ...snapshot,
        credentialGeneration: current.credentialGeneration,
      }),
    ).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT last_refreshed_at FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ last_refreshed_at: kit.clock.now() });
    await kit.settle();
  }, 120_000);

  it('rejects a transfer started at the final write and a matching post-start snapshot', async () => {
    const { kit: pendingKit, pass } = await setupSamsungCallbacks({
      db: await isolatedKeysetDatabase(),
    });
    const snapshot = {
      passId: pass.id,
      orgId: pass.orgId,
      identityId: pass.identityId,
      mode: pass.mode,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      credentialKeysetCommitment: await requireCredentialRefKeyset(
        pendingKit.env.DB,
        pendingKit.env,
      ),
      passVersion: pass.version,
      status: pass.status,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      connectionId: pass.connectionId,
      externalRef: pass.externalRef,
      generation: null,
      connectionMode: null,
    };
    let afterStart: unknown;
    const gate = interveneAtD1(
      pendingKit.env.DB,
      {
        method: 'batch',
        sql: /UPDATE passes SET last_refreshed_at/i,
        when: 'before',
      },
      async () => {
        expect((await beginTransfer(pendingKit, pass)).state).toBe('pending');
        afterStart = await first(pendingKit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      },
    );
    const env = { ...pendingKit.env, DB: gate.db } as AppEnv;
    expect(await enqueueRefreshPush({ ...jobCtxOf(pendingKit), env }, snapshot)).toBe(false);
    expect(gate.hits()).toBe(1);
    expect(await first(pendingKit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      afterStart,
    );
    const pending = await getPass(pendingKit.env.DB, pass.id);
    if (!pending) throw new Error('Missing pending pass');
    const pendingSnapshot = {
      ...snapshot,
      identityId: pending.identityId,
      passVersion: pending.version,
      ownerUserId: pending.ownerUserId,
      linkGeneration: pending.linkGeneration,
      credentialGeneration: pending.credentialGeneration,
      lifecycleGeneration: pending.lifecycleGeneration,
    };
    expect(await enqueueRefreshPush(jobCtxOf(pendingKit), pendingSnapshot)).toBe(false);
    expect(
      await markRefreshCompleted(jobCtxOf(pendingKit), pendingSnapshot, pendingKit.clock.now()),
    ).toBe(false);
    expect(await first(pendingKit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      afterStart,
    );
    expect(
      await all(pendingKit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
        pass.id,
      ]),
    ).toEqual([]);
  }, 120_000);

  it('rejects Test connector bindings even if a caller supplies a matching Test snapshot', async () => {
    const { pass, snapshot } = await bound(kit.org.id, 'test');
    expect(await enqueueRefreshPush(job(), { ...snapshot, mode: 'test' })).toBe(false);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('rejects a refresh if the organization is suspended', async () => {
    const org = await makeOrg(kit.fx);
    const { pass, snapshot } = await bound(org.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await enqueueRefreshPush(job(), snapshot)).toBe(false);
    expect(
      (
        await first<{ last_refreshed_at: number | null }>(
          kit.env.DB,
          'SELECT last_refreshed_at FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.last_refreshed_at,
    ).toBeNull();
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('allows a standalone Test pass to get a catch-up push', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const row = await first<{
      version: number;
      owner_user_id: string | null;
      link_generation: number;
    }>(kit.env.DB, 'SELECT version, owner_user_id, link_generation FROM passes WHERE id = ?', [
      pass.id,
    ]);
    if (!row) throw new Error('missing pass');
    expect(
      await enqueueRefreshPush(job(), {
        passId: pass.id,
        orgId: kit.org.id,
        mode: 'test',
        status: 'active',
        passVersion: row.version,
        ownerUserId: row.owner_user_id,
        linkGeneration: row.link_generation,
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
        lifecycleGeneration: pass.lifecycleGeneration,
        connectionId: null,
        externalRef: null,
        generation: null,
        connectionMode: null,
      }),
    ).toBe(true);
    await kit.settle();
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toHaveLength(1);
  });
});

describe('quarantined push isolation', () => {
  function withDb(db: D1Database): AppEnv {
    return { ...kit.env, DB: db } as AppEnv;
  }

  it('excludes quarantined registrations but retains clean Test registrations', async () => {
    const pass = await kit.pass({ mode: 'test' });
    await kit.device(pass, `quarantine-${pass.id}`, A);
    expect(
      await devicesForPass(kit.env.DB, pass.id, pass.identityId, pass.credentialGeneration),
    ).toHaveLength(1);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(
      await devicesForPass(kit.env.DB, pass.id, pass.identityId, pass.credentialGeneration),
    ).toEqual([]);
    await expect(enqueuePush(job(), pass.id, 'refresh')).rejects.toMatchObject({
      code: 'PASS_NOT_FOUND',
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('distinguishes a coalesced push from a quarantined pass atomically', async () => {
    const pass = await kit.pass();
    const row = {
      id: `coalesce-${pass.id}`,
      orgId: pass.orgId,
      mode: pass.mode,
      passId: pass.id,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      coalesceKey: `push:${JSON.stringify([
        pass.id,
        pass.identityId,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.templateId,
        pass.templateVersion,
        pass.releaseId,
      ])}`,
      payload: {
        reason: 'refresh',
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
      },
      now: kit.clock.now(),
    };
    expect(await insertPushOutbox(job(), row)).toBe('inserted');
    expect(await insertPushOutbox(job(), { ...row, id: `another-${pass.id}` })).toBe('coalesced');
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await insertPushOutbox(job(), { ...row, id: `blocked-${pass.id}` })).toBe('stale');
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toHaveLength(1);
  });

  it('rejects a quarantine flip between enqueue prefetch and its D1 commit', async () => {
    const pass = await kit.pass();
    let flipped = false;
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            flipped = true;
            await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
              pass.id,
            ]);
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      enqueuePush({ ...job(), env: withDb(db) }, pass.id, 'refresh'),
    ).rejects.toMatchObject({ code: 'PASS_NOT_FOUND' });
    expect(flipped).toBe(true);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toEqual([]);
  });

  it('cancels a queued push that became quarantined before delivery', async () => {
    const { pass, outboxId } = await scenario();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    kit.apns.sent.length = 0;
    await deliver(outboxId);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
  });

  it('cancels when quarantine changes during APNs availability lookup', async () => {
    const { pass, outboxId } = await scenario();
    const previous = kit.apns.isAvailable;
    kit.apns.sent.length = 0;
    kit.apns.isAvailable = async () => {
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
      return true;
    };
    try {
      await deliver(outboxId);
    } finally {
      kit.apns.isAvailable = previous;
    }
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
  });

  it('rechecks quarantine after recipient lookup and before APNs', async () => {
    const { pass, outboxId } = await scenario();
    kit.apns.sent.length = 0;
    let flipped = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
          if (prop === 'all' && sql.includes('FROM push_results WHERE outbox_id')) {
            return async () => {
              const rows = await target.all();
              await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
                pass.id,
              ]);
              flipped = true;
              return rows;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = withDb(db);
    overrideDeps(env, { apns: kit.apns });
    await handlePushDeliver({ kind: 'push.deliver', outboxId }, { ...job(), env });
    expect(flipped).toBe(true);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
  });

  it('still delivers a clean standalone Test pass', async () => {
    const pass = await kit.pass({ mode: 'test' });
    await kit.device(pass, `test-push-${pass.id}`, A);
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    if (!row) throw new Error('missing push');
    kit.apns.sent.length = 0;
    await deliver(row.id);
    expect(kit.apns.sent.map((target) => target.token)).toEqual([A]);
    expect(await getOutbox(kit.env.DB, row.id)).toMatchObject({ state: 'sent' });
  });
});

describe('per-device APNs handling', () => {
  it('removes dead tokens, retries only the transient device and finishes sent', async () => {
    const { pass, outboxId } = await scenario();
    kit.apns.sent.length = 0;
    kit.apns.results.set(A, { status: 410, reason: 'Unregistered' });
    kit.apns.results.set(B, { status: 429, reason: 'TooManyRequests' });
    await expect(deliver(outboxId)).rejects.toBeInstanceOf(TransientDeliveryError);

    // One bad token did not stop the others (audit B1).
    expect(kit.apns.sent.map((s) => s.token).sort()).toEqual([A, B, C]);
    expect(await registrations(pass.id)).toBe(2);
    const results = await all<{ device_id: string; http_status: number }>(
      kit.env.DB,
      'SELECT device_id, http_status FROM push_results WHERE outbox_id = ?',
      [outboxId],
    );
    expect(results).toHaveLength(3);
    const released = await getOutbox(kit.env.DB, outboxId);
    expect(released).toMatchObject({ state: 'enqueued', attempts: 1, errorCode: 'APNS_TRANSIENT' });

    kit.apns.sent.length = 0;
    kit.apns.results.delete(B);
    await deliver(outboxId);
    expect(kit.apns.sent.map((s) => s.token)).toEqual([B]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('treats BadDeviceToken and DeviceTokenNotForTopic as dead registrations', async () => {
    const { pass, outboxId } = await scenario();
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    kit.apns.results.set(B, { status: 400, reason: 'DeviceTokenNotForTopic' });
    await deliver(outboxId);
    expect(await registrations(pass.id)).toBe(1);
    expect((await getOutbox(kit.env.DB, outboxId))?.state).toBe('sent');
    kit.apns.results.clear();
  });

  it('marks the identity failing on certificate errors and healthy again after a success', async () => {
    const { pass, outboxId } = await scenario();
    kit.apns.results.set(A, { status: 403, reason: 'BadCertificate' });
    await expect(deliver(outboxId)).rejects.toBeInstanceOf(TransientDeliveryError);
    const health = () =>
      first<{ apns_health: string }>(
        kit.env.DB,
        'SELECT apns_health FROM signing_identities WHERE id = ?',
        [pass.identityId],
      );
    expect((await health())?.apns_health).toBe('failing');
    expect(await registrations(pass.id)).toBe(3);
    kit.apns.results.clear();
    await deliver(outboxId);
    expect((await health())?.apns_health).toBe('healthy');
  });

  it('finishes partial when a device is rejected permanently', async () => {
    const { outboxId } = await scenario();
    kit.apns.results.set(C, { status: 400, reason: 'PayloadEmpty' });
    await deliver(outboxId);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'partial',
      errorCode: 'APNS_REJECTED',
    });
    kit.apns.results.clear();
  });

  it('stops retrying on the last attempt instead of throwing', async () => {
    const { outboxId } = await scenario();
    await run(kit.env.DB, 'UPDATE outbox SET max_attempts = 1 WHERE id = ?', [outboxId]);
    kit.apns.results.set(A, { status: 503 });
    await deliver(outboxId);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'partial',
      errorCode: 'APNS_TRANSIENT',
    });
    kit.apns.results.clear();
  });

  it('is cancelled, not failed, when push is unavailable for the identity', async () => {
    const { outboxId } = await scenario();
    kit.apns.available = false;
    await deliver(outboxId);
    kit.apns.available = true;
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PUSH_UNAVAILABLE',
    });
  });

  it('finishes as No devices, not sent, when no device is registered', async () => {
    const pass = await kit.pass();
    await enqueuePush(job(), pass.id, 'publish');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    await deliver(row?.id ?? '');
    const done = await getOutbox(kit.env.DB, row?.id ?? '');
    expect(done?.state).toBe('cancelled');
    expect(done?.errorCode).toBe('NO_DEVICES');
  });

  it('a duplicate message does not send again while the first holds the lease', async () => {
    const { outboxId } = await scenario();
    await deliver(outboxId);
    kit.apns.sent.length = 0;
    await deliver(outboxId);
    expect(kit.apns.sent).toHaveLength(0);
  });

  it('fails a row whose attempts are used up when its message finally arrives', async () => {
    const { outboxId } = await scenario();
    await run(kit.env.DB, 'UPDATE outbox SET attempts = max_attempts WHERE id = ?', [outboxId]);
    await deliver(outboxId);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'failed',
      errorCode: 'MAX_ATTEMPTS',
    });
  });

  it('does nothing when the pass was deleted meanwhile', async () => {
    const { pass, outboxId } = await scenario();
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    kit.apns.sent.length = 0;
    await deliver(outboxId);
    expect(kit.apns.sent).toHaveLength(0);
    expect(await getOutbox(kit.env.DB, outboxId)).toBeNull();
  });
});

describe('push credential transfer fences', () => {
  async function onePush() {
    const pass = await kit.pass();
    const device = `push-transfer-${pass.id}`;
    await kit.device(pass, device, A);
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
      [pass.id],
    );
    if (!row) throw new Error('Missing push outbox');
    return { pass, device, outboxId: row.id };
  }

  async function transferAndRegister(pass: Pass, device: string) {
    expect((await beginTransfer(kit, pass)).state).toBe('completed');
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing transferred pass');
    expect(current.credentialGeneration).toBe(pass.credentialGeneration + 1);
    await kit.device(current, device, A);
    return current;
  }

  async function deliverWithDb(outboxId: string, db: D1Database) {
    const env = { ...kit.env, DB: db } as AppEnv;
    overrideDeps(env, { apns: kit.apns });
    await handlePushDeliver({ kind: 'push.deliver', outboxId }, { ...job(), env });
  }

  it('does not send when the captured release changes after recipient lookup', async () => {
    const { pass, device, outboxId } = await onePush();
    expect(pass.releaseId).not.toBeNull();
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'all',
        sql: /FROM push_results WHERE outbox_id/i,
        when: 'after',
      },
      async () => {
        await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
      },
    );
    kit.apns.sent.length = 0;
    await deliverWithDb(outboxId, gate.db);
    expect(gate.hits()).toBe(1);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ? AND device_id = ?', [
        pass.id,
        device,
      ]),
    ).not.toBeNull();
  }, 120_000);

  it.each([
    { stage: 'result', sql: /INSERT OR REPLACE INTO push_results/i, saved: 0 },
    { stage: 'event', sql: /INSERT INTO pass_events/i, saved: 1 },
  ])(
    'fences $stage and cleanup when the captured release changes in flight',
    async ({ sql, saved }) => {
      const { pass, device, outboxId } = await onePush();
      expect(pass.releaseId).not.toBeNull();
      kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
      const gate = interveneAtD1(kit.env.DB, { method: 'batch', sql, when: 'before' }, async () => {
        await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
      });
      try {
        await deliverWithDb(outboxId, gate.db);
      } finally {
        kit.apns.results.delete(A);
      }
      expect(gate.hits()).toBe(1);
      expect(
        await all(kit.env.DB, 'SELECT 1 FROM push_results WHERE outbox_id = ?', [outboxId]),
      ).toHaveLength(saved);
      expect(
        await first(
          kit.env.DB,
          `SELECT 1 FROM pass_events WHERE pass_id = ?
      AND kind IN ('push.failed', 'device.unregistered')`,
          [pass.id],
        ),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ? AND device_id = ?', [
          pass.id,
          device,
        ]),
      ).not.toBeNull();
      expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'PASS_GONE',
      });
    },
    120_000,
  );

  it('does not send a snapshot when transfer completes after recipient lookup', async () => {
    const { pass, device, outboxId } = await onePush();
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'all',
        sql: /FROM push_results WHERE outbox_id/i,
        when: 'after',
      },
      async () => {
        await transferAndRegister(pass, device);
      },
    );
    kit.apns.sent.length = 0;
    await deliverWithDb(outboxId, gate.db);
    expect(gate.hits()).toBe(1);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled' });
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_generation, push_token FROM registrations
      WHERE pass_id = ? AND device_id = ?`,
        [pass.id, device],
      ),
    ).toEqual({ credential_generation: pass.credentialGeneration + 1, push_token: A });
  }, 120_000);

  it('rejects an old outbox if a previously claimed delivery is reclaimed after transfer', async () => {
    const { pass, device, outboxId } = await onePush();
    await transferAndRegister(pass, device);
    // Model an old processing row reclaimed by a concurrent recovery worker.
    await run(
      kit.env.DB,
      `UPDATE outbox SET state = 'enqueued', lease = NULL, finished_at = NULL
      WHERE id = ?`,
      [outboxId],
    );
    kit.apns.sent.length = 0;
    await deliver(outboxId);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_generation, push_token FROM registrations
      WHERE pass_id = ? AND device_id = ?`,
        [pass.id, device],
      ),
    ).toEqual({ credential_generation: pass.credentialGeneration + 1, push_token: A });
  }, 120_000);

  it('keeps the new registration after an in-flight bad-token response and rejects the old Apple credential', async () => {
    const { pass, device, outboxId } = await onePush();
    const send = kit.apns.send;
    const transferred: { current?: Pass } = {};
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    kit.apns.send = async (target, tokens, now) => {
      const results = await send.call(kit.apns, target, tokens, now);
      transferred.current = await transferAndRegister(pass, device);
      return results;
    };
    try {
      await deliver(outboxId);
    } finally {
      kit.apns.send = send;
      kit.apns.results.delete(A);
    }
    const current = transferred.current;
    if (!current) throw new Error('Transfer did not run');
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_generation, push_token FROM registrations
      WHERE pass_id = ? AND device_id = ?`,
        [pass.id, device],
      ),
    ).toEqual({ credential_generation: current.credentialGeneration, push_token: A });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM push_results WHERE outbox_id = ?', [outboxId]),
    ).toBeNull();
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled' });

    const app = createApp({ clock: kit.clock });
    const latest = (serial: string, token: string) =>
      app.request(
        `https://wallet.test/wallet/v1/passes/pass.im.plrs.wallet/${serial}`,
        { headers: { authorization: `ApplePass ${token}` } },
        kit.env,
      );
    expect((await latest(pass.serial, pass.authToken)).status).toBe(401);
    expect((await latest(current.serial, pass.authToken)).status).toBe(401);
    expect((await latest(current.serial, current.authToken)).status).toBe(200);

    // A leftover source-generation row is never included in a replacement push.
    const staleDevice = `stale-${pass.id}`;
    await run(
      kit.env.DB,
      `INSERT INTO devices (device_id, identity_id, push_token, updated_at)
      VALUES (?, ?, ?, ?)`,
      [staleDevice, pass.identityId, B, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      `INSERT INTO registrations
      (device_id, identity_id, pass_id, push_token, created_at, credential_generation)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [staleDevice, pass.identityId, pass.id, B, kit.clock.now(), pass.credentialGeneration],
    );
    expect(
      await devicesForPass(kit.env.DB, pass.id, pass.identityId, pass.credentialGeneration),
    ).toEqual([]);
    expect(
      (
        await devicesForPass(kit.env.DB, pass.id, pass.identityId, current.credentialGeneration)
      ).map((target) => target.deviceId),
    ).toEqual([device]);
  }, 120_000);

  it('cannot overwrite a later result when transfer commits before the result batch', async () => {
    const { pass, device, outboxId } = await onePush();
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /INSERT OR REPLACE INTO push_results/i,
        when: 'before',
      },
      async () => {
        await transferAndRegister(pass, device);
        await run(
          kit.env.DB,
          `INSERT INTO push_results
        (outbox_id, device_id, http_status, reason, at) VALUES (?, ?, 200, 'later', ?)`,
          [outboxId, device, kit.clock.now()],
        );
      },
    );
    try {
      await deliverWithDb(outboxId, gate.db);
    } finally {
      kit.apns.results.delete(A);
    }
    expect(gate.hits()).toBe(1);
    expect(
      await first(
        kit.env.DB,
        `SELECT http_status, reason FROM push_results
      WHERE outbox_id = ? AND device_id = ?`,
        [outboxId, device],
      ),
    ).toEqual({ http_status: 200, reason: 'later' });
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_events WHERE pass_id = ?
      AND kind IN ('push.failed', 'device.unregistered')`,
        [pass.id],
      ),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_generation FROM registrations
      WHERE pass_id = ? AND device_id = ?`,
        [pass.id, device],
      ),
    ).toEqual({ credential_generation: pass.credentialGeneration + 1 });
  }, 120_000);

  it('fences delayed event writes when transfer starts after the result was saved', async () => {
    const { pass, device, outboxId } = await onePush();
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /INSERT INTO pass_events/i,
        when: 'before',
      },
      async () => {
        await transferAndRegister(pass, device);
      },
    );
    try {
      await deliverWithDb(outboxId, gate.db);
    } finally {
      kit.apns.results.delete(A);
    }
    expect(gate.hits()).toBe(1);
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_events WHERE pass_id = ?
      AND kind IN ('push.failed', 'device.unregistered')`,
        [pass.id],
      ),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_generation FROM registrations
      WHERE pass_id = ? AND device_id = ?`,
        [pass.id, device],
      ),
    ).toEqual({ credential_generation: pass.credentialGeneration + 1 });
  }, 120_000);

  it('rechecks the originating generation during cleanup even if its lease is still present', async () => {
    const { pass, device, outboxId } = await onePush();
    const shared = await kit.pass();
    await kit.device(shared, device, A);
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /DELETE FROM registrations/i,
        when: 'before',
      },
      async () => {
        const lease = await first<{ lease: string }>(
          kit.env.DB,
          'SELECT lease FROM outbox WHERE id = ?',
          [outboxId],
        );
        if (!lease?.lease) throw new Error('Missing processing lease');
        await transferAndRegister(pass, device);
        // Isolate the generation predicate from START's independent lease cancellation.
        await run(kit.env.DB, "UPDATE outbox SET state = 'processing', lease = ? WHERE id = ?", [
          lease.lease,
          outboxId,
        ]);
      },
    );
    try {
      await deliverWithDb(outboxId, gate.db);
    } finally {
      kit.apns.results.delete(A);
    }
    expect(gate.hits()).toBe(1);
    expect(
      await all(
        kit.env.DB,
        `SELECT pass_id, credential_generation FROM registrations
      WHERE device_id = ? ORDER BY pass_id`,
        [device],
      ),
    ).toEqual(
      [
        { pass_id: pass.id, credential_generation: pass.credentialGeneration + 1 },
        { pass_id: shared.id, credential_generation: shared.credentialGeneration },
      ].sort((a, b) => a.pass_id.localeCompare(b.pass_id)),
    );
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled' });
  }, 120_000);

  it('cleans only snapshotted shared registrations, not a transferred or newly attached pass', async () => {
    const { pass, device, outboxId } = await onePush();
    const shared = await kit.pass();
    const newcomer = await kit.pass();
    await kit.device(shared, device, A);
    kit.apns.results.set(A, { status: 400, reason: 'BadDeviceToken' });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /DELETE FROM registrations/i,
        when: 'before',
      },
      async () => {
        await transferAndRegister(shared, device);
        await kit.device(newcomer, device, A);
      },
    );
    try {
      await deliverWithDb(outboxId, gate.db);
    } finally {
      kit.apns.results.delete(A);
    }
    expect(gate.hits()).toBe(1);
    const remaining = await all<{ pass_id: string; credential_generation: number }>(
      kit.env.DB,
      'SELECT pass_id, credential_generation FROM registrations WHERE device_id = ? ORDER BY pass_id',
      [device],
    );
    expect(remaining).toEqual(
      [
        { pass_id: shared.id, credential_generation: shared.credentialGeneration + 1 },
        { pass_id: newcomer.id, credential_generation: newcomer.credentialGeneration },
      ].sort((a, b) => a.pass_id.localeCompare(b.pass_id)),
    );
    expect(remaining.some((row) => row.pass_id === pass.id)).toBe(false);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM devices WHERE device_id = ?', [device]),
    ).not.toBeNull();
  }, 120_000);

  it('does not change identity health when the pass transfers before the health write', async () => {
    const { pass, device, outboxId } = await onePush();
    await run(kit.env.DB, "UPDATE signing_identities SET apns_health = 'healthy' WHERE id = ?", [
      pass.identityId,
    ]);
    kit.apns.results.set(A, { status: 403, reason: 'BadCertificate' });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'run',
        sql: /UPDATE signing_identities SET apns_health/i,
        when: 'before',
      },
      async () => {
        await transferAndRegister(pass, device);
      },
    );
    try {
      await deliverWithDb(outboxId, gate.db);
    } finally {
      kit.apns.results.delete(A);
    }
    expect(gate.hits()).toBe(1);
    expect(
      await first(kit.env.DB, 'SELECT apns_health FROM signing_identities WHERE id = ?', [
        pass.identityId,
      ]),
    ).toEqual({ apns_health: 'healthy' });
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled' });
  }, 120_000);

  it('does not deliver even a matching-generation registration while a transfer is pending', async () => {
    const fixture = await setupSamsungCallbacks({ db: await isolatedKeysetDatabase() });
    const { kit: pendingKit, pass } = fixture;
    const device = `pending-push-${pass.id}`;
    await pendingKit.device(pass, device, A);
    expect((await beginTransfer(pendingKit, pass)).state).toBe('pending');
    const current = await getPass(pendingKit.env.DB, pass.id);
    if (!current) throw new Error('Missing pending pass');
    // Simulate an imported or leftover registration: the independent read must still deny it.
    await run(
      pendingKit.env.DB,
      `INSERT INTO registrations
      (device_id, identity_id, pass_id, push_token, created_at, credential_generation)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [device, pass.identityId, pass.id, A, pendingKit.clock.now(), current.credentialGeneration],
    );
    const outboxId = `pending-transfer-${pass.id}`;
    await run(
      pendingKit.env.DB,
      `INSERT INTO outbox (id, org_id, kind, pass_id, payload, state, created_at)
      VALUES (?, ?, 'push', ?, ?, 'enqueued', ?)`,
      [
        outboxId,
        pass.orgId,
        pass.id,
        JSON.stringify({
          reason: 'refresh',
          identityId: current.identityId,
          credentialGeneration: current.credentialGeneration,
          lifecycleGeneration: current.lifecycleGeneration,
          templateId: current.templateId,
          templateVersion: current.templateVersion,
          releaseId: current.releaseId,
        }),
        pendingKit.clock.now(),
      ],
    );
    expect(
      await devicesForPass(
        pendingKit.env.DB,
        pass.id,
        pass.identityId,
        current.credentialGeneration,
      ),
    ).toEqual([]);
    pendingKit.apns.sent.length = 0;
    await handlePushDeliver({ kind: 'push.deliver', outboxId }, pendingKit.ctx);
    expect(pendingKit.apns.sent).toEqual([]);
    expect(await getOutbox(pendingKit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'PASS_GONE',
    });
    const response = await createApp({ clock: pendingKit.clock }).request(
      `https://wallet.test/wallet/v1/passes/pass.im.plrs.wallet/${pass.serial}`,
      { headers: { authorization: `ApplePass ${pass.authToken}` } },
      pendingKit.env,
    );
    expect(response.status).toBe(401);
    expect(
      await first(
        pendingKit.env.DB,
        'SELECT 1 FROM registrations WHERE pass_id = ? AND device_id = ?',
        [pass.id, device],
      ),
    ).not.toBeNull();
  }, 120_000);
});

describe('dead letters', () => {
  it('marks the row failed and writes an audit event without recipient data', async () => {
    const { pass, outboxId } = await scenario();
    await handleDeadLetter({ kind: 'push.deliver', outboxId }, job());
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'failed',
      errorCode: 'DEAD_LETTER',
    });
    const audit = await first<{ action: string }>(
      kit.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'delivery.dead_letter'",
      [pass.id],
    );
    expect(audit).not.toBeNull();
    // Already final: a second dead letter changes nothing.
    await handleDeadLetter({ kind: 'push.deliver', outboxId }, job());
  });

  it('ignores job kinds it does not own', async () => {
    await handleDeadLetter(
      {
        kind: 'connection.webhook',
        connectionId: 'c',
        orgId: kit.org.id,
        generation: 1,
        eventId: 'e',
        refs: [],
      },
      job(),
    );
  });
});

describe('APNs request shape', () => {
  it('sends an empty background push with topic, priority 5 and a 7 day expiry', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 200, headers: { 'apns-id': 'id-1' } });
      },
    } as unknown as Fetcher;
    const transport = createMtlsApnsTransport({ ...kit.env, APNS: fetcher });
    const now = 1_800_000_000_000;
    const [result] = await transport.send(
      { passTypeIdentifier: 'pass.test', apnsBinding: 'APNS' },
      [A],
      now,
    );
    expect(result).toMatchObject({ token: A, status: 200, apnsId: 'id-1' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe(`https://api.push.apple.com/3/device/${A}`);
    expect(headers).toMatchObject({
      'apns-topic': 'pass.test',
      'apns-push-type': 'background',
      'apns-priority': '5',
      'apns-expiration': String(now / 1000 + 7 * 86400),
    });
    expect(calls[0]?.init.body).toBe('{}');
  });
});
