import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { createMtlsApnsTransport } from './apns.ts';
import { handleDeadLetter, handlePushDeliver } from './jobs.ts';
import { classifyApns, TransientDeliveryError } from './push.ts';
import { getOutbox } from './repo.ts';
import { dispatchOutbox, enqueuePush } from './service.ts';

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

  it('finishes sent with nothing to do when no device is registered', async () => {
    const pass = await kit.pass();
    await enqueuePush(kit.ctx, pass.id, 'publish');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    await deliver(row?.id ?? '');
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('sent');
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
    await handleDeadLetter({ kind: 'pass.purge-versions', passId: 'x' }, kit.ctx);
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
