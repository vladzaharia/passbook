import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { create as createConnection } from '../connections/service.ts';
import { overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { createMtlsApnsTransport } from './apns.ts';
import { handleDeadLetter, handlePushDeliver } from './jobs.ts';
import { classifyApns, TransientDeliveryError } from './push.ts';
import { devicesForPass, getOutbox, insertPushOutbox } from './repo.ts';
import { dispatchOutbox, enqueuePush, enqueueRefreshPush } from './service.ts';

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
  await enqueuePush(kit.ctx, pass.id, 'refresh');
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
    expect(await dispatchOutbox(kit.ctx)).toBe(0);
    await kit.settle();
    expect(
      kit.queue.sent.filter((m) => (m as { outboxId: string }).outboxId === outboxId),
    ).toHaveLength(1);
  });

  it('reverts to pending when the queue is down, then sends on the next tick', async () => {
    const pass = await kit.pass();
    kit.queue.fail = true;
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string; state: string }>(
      kit.env.DB,
      "SELECT id, state FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(row?.state).toBe('pending');
    kit.queue.fail = false;
    expect(await dispatchOutbox(kit.ctx)).toBeGreaterThanOrEqual(1);
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('enqueued');
  });
});

describe('guarded refresh push', () => {
  async function bound(orgId = kit.org.id) {
    const pass = await kit.pass({ orgId });
    const connection = await createConnection(kit.ctx, { type: 'system', id: null }, {
      orgId, connectorType: 'demo', name: 'Refresh', config: { count: 1 }, mode: 'manual',
    } as never);
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connection.id, 'm-001', pass.id,
    ]);
    const row = await first<{ version: number; owner_user_id: string | null; link_generation: number }>(
      kit.env.DB, 'SELECT version, owner_user_id, link_generation FROM passes WHERE id = ?', [pass.id],
    );
    if (!row) throw new Error('missing pass');
    return {
      pass,
      connection,
      snapshot: {
        passId: pass.id, orgId, mode: 'live' as const, status: 'active' as const,
        passVersion: row.version, ownerUserId: row.owner_user_id, linkGeneration: row.link_generation,
        connectionId: connection.id, externalRef: 'm-001', generation: 1,
      },
    };
  }

  it('atomically stamps and queues a valid Live refresh', async () => {
    const { pass, snapshot } = await bound();
    expect(await enqueueRefreshPush(kit.ctx, snapshot)).toBe(true);
    await kit.settle();
    const row = await first<{ last_refreshed_at: number | null }>(
      kit.env.DB, 'SELECT last_refreshed_at FROM passes WHERE id = ?', [pass.id],
    );
    expect(row?.last_refreshed_at).toBe(kit.clock.now());
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toHaveLength(1);
  });

  it.each([
    ['mode', "UPDATE passes SET mode = 'test' WHERE id = ?", false],
    ['version', 'UPDATE passes SET version = version + 1 WHERE id = ?', false],
    ['holder generation', 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', false],
    ['reference', "UPDATE passes SET external_ref = 'other' WHERE id = ?", false],
    ['deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?', false],
    ['removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', false],
    ['quarantine', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', false],
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?", false],
    ['generation', 'UPDATE connections SET generation = generation + 1 WHERE id = ?', true],
    ['disabled', 'UPDATE connections SET enabled = 0 WHERE id = ?', true],
  ] as const)('does not stamp or queue after %s changes', async (_label, sql, onConnection) => {
    const { pass, connection, snapshot } = await bound();
    await run(kit.env.DB, sql, [onConnection ? connection.id : pass.id]);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(await enqueueRefreshPush(kit.ctx, snapshot)).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toEqual([]);
  });

  it('rejects Test connector bindings even if a caller supplies a matching Test snapshot', async () => {
    const { pass, snapshot } = await bound();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    expect(await enqueueRefreshPush(kit.ctx, { ...snapshot, mode: 'test' })).toBe(false);
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toEqual([]);
  });

  it('rejects a refresh if the organization is suspended', async () => {
    const org = await makeOrg(kit.fx);
    const { pass, snapshot } = await bound(org.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await enqueueRefreshPush(kit.ctx, snapshot)).toBe(false);
    expect((await first<{ last_refreshed_at: number | null }>(
      kit.env.DB, 'SELECT last_refreshed_at FROM passes WHERE id = ?', [pass.id],
    ))?.last_refreshed_at).toBeNull();
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toEqual([]);
  });

  it('allows a standalone Test pass to get a catch-up push', async () => {
    const pass = await kit.pass();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    const row = await first<{ version: number; owner_user_id: string | null; link_generation: number }>(
      kit.env.DB, 'SELECT version, owner_user_id, link_generation FROM passes WHERE id = ?', [pass.id],
    );
    if (!row) throw new Error('missing pass');
    expect(await enqueueRefreshPush(kit.ctx, {
      passId: pass.id, orgId: kit.org.id, mode: 'test', status: 'active',
      passVersion: row.version, ownerUserId: row.owner_user_id, linkGeneration: row.link_generation,
      connectionId: null, externalRef: null, generation: null,
    })).toBe(true);
    await kit.settle();
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toHaveLength(1);
  });
});

describe('quarantined push isolation', () => {
  function withDb(db: D1Database): AppEnv {
    const env = Object.create(kit.env) as AppEnv;
    Object.defineProperty(env, 'DB', { value: db, enumerable: true });
    return env;
  }

  it('excludes quarantined registrations but retains clean Test registrations', async () => {
    const pass = await kit.pass();
    await kit.device(pass, `quarantine-${pass.id}`, A);
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    expect(await devicesForPass(kit.env.DB, pass.id, pass.identityId)).toHaveLength(1);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await devicesForPass(kit.env.DB, pass.id, pass.identityId)).toEqual([]);
    await expect(enqueuePush(kit.ctx, pass.id, 'refresh')).rejects.toMatchObject({ code: 'PASS_NOT_FOUND' });
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toEqual([]);
  });

  it('distinguishes a coalesced push from a quarantined pass atomically', async () => {
    const pass = await kit.pass();
    const row = {
      id: `coalesce-${pass.id}`, orgId: pass.orgId, passId: pass.id,
      coalesceKey: `push:${pass.id}`, payload: { reason: 'refresh' }, now: kit.clock.now(),
    };
    expect(await insertPushOutbox(kit.env.DB, row)).toBe('inserted');
    expect(await insertPushOutbox(kit.env.DB, { ...row, id: `another-${pass.id}` })).toBe('coalesced');
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await insertPushOutbox(kit.env.DB, { ...row, id: `blocked-${pass.id}` })).toBe('stale');
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toHaveLength(1);
  });

  it('rejects a quarantine flip between enqueue prefetch and its D1 commit', async () => {
    const pass = await kit.pass();
    let flipped = false;
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
          flipped = true;
          await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
          return target.batch(statements);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(enqueuePush({ ...kit.ctx, env: withDb(db) }, pass.id, 'refresh'))
      .rejects.toMatchObject({ code: 'PASS_NOT_FOUND' });
    expect(flipped).toBe(true);
    expect(await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id])).toEqual([]);
  });

  it('cancels a queued push that became quarantined before delivery', async () => {
    const { pass, outboxId } = await scenario();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    kit.apns.sent.length = 0;
    await deliver(outboxId);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled', errorCode: 'PASS_GONE' });
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
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled', errorCode: 'PASS_GONE' });
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
              await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
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
    await handlePushDeliver({ kind: 'push.deliver', outboxId }, { ...kit.ctx, env });
    expect(flipped).toBe(true);
    expect(kit.apns.sent).toEqual([]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'cancelled', errorCode: 'PASS_GONE' });
  });

  it('still delivers a clean standalone Test pass', async () => {
    const pass = await kit.pass();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    await kit.device(pass, `test-push-${pass.id}`, A);
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id],
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
    await enqueuePush(kit.ctx, pass.id, 'publish');
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

describe('dead letters', () => {
  it('marks the row failed and writes an audit event without recipient data', async () => {
    const { pass, outboxId } = await scenario();
    await handleDeadLetter({ kind: 'push.deliver', outboxId }, kit.ctx);
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
    await handleDeadLetter({ kind: 'push.deliver', outboxId }, kit.ctx);
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
      kit.ctx,
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
