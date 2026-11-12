import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { dailyConnections, FAILED_WEBHOOK_TTL_MS, reconcileConnections } from './jobs.ts';
import { getConnection } from './repo.ts';
import { startPendingTransfer } from './runtime-fixtures.ts';
import { remove } from './service.ts';
import {
  addMembership,
  createDemo,
  type Kit,
  linkedPass,
  makeKit,
  withWorkflow,
} from './test-kit.ts';
import { chunkHash } from './webhook-payload.ts';
import { stageRetainedWebhook } from './webhook-retention.ts';
import { receiveWebhook } from './webhooks.ts';

let kit: Kit;
let app: OpenAPIHono<AppBindings>;
let headers: Record<string, string>;

beforeEach(async () => {
  kit = await makeKit();
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  headers = (await makeSession(kit, { userId: kit.actor.id })).headers;
  app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
}, 60_000);

async function pushConnection() {
  const dto = await createDemo(kit, {
    connectorType: 'webhook-push',
    config: {},
    mode: 'webhook',
  } as never);
  if (!dto.webhookSecret) throw new Error('Missing webhook secret');
  return { id: dto.id, secret: dto.webhookSecret };
}

async function deliver(id: string, secret: string, body: unknown) {
  const text = JSON.stringify(body);
  const ts = Math.floor(kit.clock.now() / 1000);
  await receiveWebhook(
    kit.sctx,
    id,
    new Request('https://wallet.test/hook', {
      method: 'POST',
      headers: {
        'x-wallet-timestamp': String(ts),
        'x-wallet-signature': await signWebhook(secret, ts, text),
      },
      body: text,
    }),
  );
}

async function call(method: 'GET' | 'POST', path: string, h = headers) {
  const response = await app.request(path, { method, headers: h }, kit.env);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const failures = (id: string) => `/api/v1/connections/${id}/webhook-failures`;

/** A chunk whose effect is unknown: its uncertain item fences the pass it claimed. */
async function uncertainChunk(extraRecords = 0) {
  const { id, secret } = await pushConnection();
  const pass = await linkedPass(kit, id, 'u-ref');
  await deliver(id, secret, {
    id: 'uncertain-event',
    records: [
      { ref: 'u-ref', record: { memberName: 'Member' } },
      ...Array.from({ length: extraRecords }, (_, i) => ({
        ref: `extra-${i}`,
        record: { memberName: 'Extra' },
      })),
    ],
  });
  const row = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM connection_webhook_retention WHERE connection_id = ?',
    [id],
  );
  if (!row) throw new Error('Missing retained chunk');
  await run(
    kit.env.DB,
    `UPDATE connection_webhook_items SET state = 'uncertain', claim_kind = 'existing',
      claim_pass_id = ? WHERE retention_id = ? AND ordinal = 0`,
    [pass.id, row.id],
  );
  await run(
    kit.env.DB,
    "UPDATE connection_webhook_retention SET state = 'failed', error_code = 'WEBHOOK_EFFECT_UNCERTAIN' WHERE id = ?",
    [row.id],
  );
  return { id, secret, pass, retentionId: row.id };
}

const itemStates = (retentionId: string) =>
  all<{ ordinal: number; state: string; error_code: string | null }>(
    kit.env.DB,
    'SELECT ordinal, state, error_code FROM connection_webhook_items WHERE retention_id = ? ORDER BY ordinal',
    [retentionId],
  );

describe('resolving an uncertain webhook', () => {
  it('releases the fence, audits the operator and refuses a later replay', async () => {
    const { id, pass, retentionId } = await uncertainChunk();
    const listed = await call('GET', failures(id));
    expect(listed.json.items).toEqual([
      expect.objectContaining({ id: retentionId, state: 'failed', uncertainItems: 1 }),
    ]);
    await expect(startPendingTransfer(kit.sctx, pass.id)).rejects.toThrow();

    const resolved = await call('POST', `${failures(id)}/${retentionId}/resolve`);
    expect(resolved).toEqual({
      status: 200,
      json: { ok: true, resolved: 1, state: 'resolved' },
    });
    expect(await itemStates(retentionId)).toEqual([
      { ordinal: 0, state: 'success', error_code: 'WEBHOOK_OPERATOR_RESOLVED' },
    ]);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE id = ?',
        [retentionId],
      ),
    ).toEqual({ state: 'resolved', error_code: null });
    expect(
      await all(
        kit.env.DB,
        `SELECT org_id, actor_type, actor_id, action, target_type, target_id, detail FROM audit_log
         WHERE action = 'connection.webhook_resolve' AND target_id = ?`,
        [id],
      ),
    ).toEqual([
      {
        org_id: kit.org.id,
        actor_type: 'user',
        actor_id: kit.actor.id,
        action: 'connection.webhook_resolve',
        target_type: 'connection',
        target_id: id,
        detail: JSON.stringify({ retentionId, resolved: 1 }),
      },
    ]);
    await startPendingTransfer(kit.sctx, pass.id);

    const replay = await call('POST', `${failures(id)}/${retentionId}/replay`);
    expect(replay.status).toBe(409);
    expect(replay.json).toMatchObject({ code: 'WEBHOOK_ALREADY_FINISHED' });
    const again = await call('POST', `${failures(id)}/${retentionId}/resolve`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'WEBHOOK_ALREADY_FINISHED' });
  }, 60_000);

  it('keeps a chunk with other unfinished items open and replayable', async () => {
    const { id, retentionId } = await uncertainChunk(1);
    const resolved = await call('POST', `${failures(id)}/${retentionId}/resolve`);
    expect(resolved.json).toEqual({ ok: true, resolved: 1, state: 'failed' });
    expect(await itemStates(retentionId)).toEqual([
      { ordinal: 0, state: 'success', error_code: 'WEBHOOK_OPERATOR_RESOLVED' },
      { ordinal: 1, state: 'pending', error_code: null },
    ]);
  }, 60_000);

  it('refuses without the manage capability, outside the organization, in Test mode, or while running', async () => {
    const { id, pass, retentionId } = await uncertainChunk();
    const path = `${failures(id)}/${retentionId}/resolve`;
    const reader = await makeUser(kit);
    await addMembership(kit, reader.id, ['read_only']);
    const readHeaders = (await makeSession(kit, { userId: reader.id })).headers;
    expect((await call('POST', path, readHeaders)).status).toBe(403);

    const otherOrg = await makeOrg(kit);
    const outsider = await makeUser(kit);
    await addMembership(kit, outsider.id, ['integration_admin'], otherOrg.id);
    const foreign = (await makeSession(kit, { userId: outsider.id })).headers;
    expect((await call('POST', path, foreign)).status).toBe(404);
    expect((await call('POST', path, { ...headers, 'x-passbook-mode': 'test' })).status).toBe(404);

    await run(
      kit.env.DB,
      "INSERT INTO connection_webhook_items (retention_id, ordinal, state, prior_unknown, release_snapshot) VALUES (?, 1, 'started', 0, 'null')",
      [retentionId],
    );
    await run(kit.env.DB, 'UPDATE connection_webhook_retention SET item_count = 2 WHERE id = ?', [
      retentionId,
    ]);
    const running = await call('POST', path);
    expect(running.status).toBe(409);
    expect(running.json).toMatchObject({ code: 'WEBHOOK_EFFECT_UNCERTAIN' });

    expect((await itemStates(retentionId))[0]).toMatchObject({ state: 'uncertain' });
    expect(
      await all(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'connection.webhook_resolve' AND target_id = ?",
        [id],
      ),
    ).toEqual([]);
    await expect(startPendingTransfer(kit.sctx, pass.id)).rejects.toThrow();
  }, 60_000);
});

describe('webhook dispatch recovery', () => {
  it('sweeps a chunk whose dispatch never completed', async () => {
    const { id, secret } = await pushConnection();
    kit.seams.failEnqueue = true;
    await expect(
      deliver(id, secret, { id: 'swept', records: [{ ref: 'a', record: { memberName: 'A' } }] }),
    ).rejects.toMatchObject({ status: 503 });
    kit.seams.failEnqueue = false;
    // Too recent to be an abandoned request.
    await reconcileConnections(kit.sctx);
    expect(kit.seams.jobs).toEqual([]);

    kit.clock.advance(6 * 60_000);
    await reconcileConnections(kit.sctx);
    expect(kit.seams.jobs).toEqual([
      expect.objectContaining({ kind: 'connection.webhook', eventId: 'swept', refs: ['a'] }),
    ]);
    expect(
      await first(
        kit.env.DB,
        "SELECT state, error_code, dispatch_complete FROM connection_webhook_retention WHERE event_id = 'swept'",
      ),
    ).toEqual({ state: 'pending', error_code: null, dispatch_complete: 1 });
    await reconcileConnections(kit.sctx);
    expect(kit.seams.jobs).toHaveLength(1);
  }, 60_000);

  it('keeps two identical chunks of one event apart by their ordinal', async () => {
    const { id } = await pushConnection();
    const conn = await getConnection(kit.env.DB, id);
    if (!conn) throw new Error('Missing connection');
    // A connector may report the same reference twice; both 20-ref chunks then hold equal lists.
    const refs = Array.from({ length: 40 }, () => 'same');
    const staged = await stageRetainedWebhook(
      kit.sctx,
      conn,
      { eventId: 'identical-chunks', refs, records: { same: { memberName: 'S' } } },
      null,
      new TextEncoder().encode('{}'),
      kit.credentialKeysetCommitment,
    );
    expect(staged).toBe('fresh');
    const rows = await all<{ ref_hash: string }>(
      kit.env.DB,
      "SELECT ref_hash FROM connection_webhook_retention WHERE event_id = 'identical-chunks'",
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.ref_hash)).size).toBe(2);
    expect(await chunkHash(0, refs.slice(0, 20))).not.toBe(await chunkHash(1, refs.slice(0, 20)));
  }, 60_000);
});

describe('retained payload lifetime', () => {
  it('expires failed payloads after the TTL but never an uncertain one', async () => {
    const { id, secret } = await pushConnection();
    await deliver(id, secret, {
      id: 'old-failed',
      records: [{ ref: 'a', record: { memberName: 'A' } }],
    });
    const uncertain = await uncertainChunk();
    const old = kit.clock.now() - FAILED_WEBHOOK_TTL_MS - 1_000;
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_retention SET state = 'failed', error_code = 'RECORD_ERRORS' WHERE event_id = 'old-failed'",
    );
    await run(
      kit.env.DB,
      'UPDATE connection_webhook_retention SET received_at = ?, updated_at = ? WHERE connection_id IN (?, ?)',
      [old, old, id, uncertain.id],
    );
    await run(
      kit.env.DB,
      'UPDATE webhook_events SET received_at = ? WHERE connection_id IN (?, ?)',
      [old, id, uncertain.id],
    );

    await dailyConnections(kit.sctx);
    expect(
      await all(
        kit.env.DB,
        'SELECT event_id FROM connection_webhook_retention WHERE connection_id IN (?, ?)',
        [id, uncertain.id],
      ),
    ).toEqual([{ event_id: 'uncertain-event' }]);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [id]),
    ).toEqual([]);
    expect((await itemStates(uncertain.retentionId))[0]).toMatchObject({ state: 'uncertain' });
  }, 60_000);

  it("purges a deleted connection's envelopes and releases the claims that still fenced a pass", async () => {
    const { id, secret } = await pushConnection();
    await deliver(id, secret, {
      id: 'purged',
      records: [{ ref: 'a', record: { memberName: 'A' } }],
    });
    const other = await pushConnection();
    await deliver(other.id, other.secret, {
      id: 'claimed',
      records: [{ ref: 'b', record: { memberName: 'B' } }],
    });
    const claimed = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM connection_webhook_retention WHERE connection_id = ?',
      [other.id],
    );
    if (!claimed) throw new Error('Missing retained chunk');
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_items SET state = 'uncertain', claim_prior_unbound = 1 WHERE retention_id = ?",
      [claimed.id],
    );
    await remove(kit.sctx, kit.actor, id);
    await remove(kit.sctx, kit.actor, other.id);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM connection_webhook_retention WHERE connection_id = ?', [
        id,
      ]),
    ).toEqual([]);
    // Nobody can resolve the claim once the connection is gone: it is released, so it fences no pass.
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM connection_webhook_retention WHERE id = ?', [
        claimed.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM connection_webhook_items WHERE retention_id = ? AND state IN ('started', 'uncertain')",
        [claimed.id],
      ),
    ).toBeNull();
    expect(await getConnection(kit.env.DB, id)).toBeNull();
  }, 60_000);
});

describe('stuck scheduled runs', () => {
  it('resumes a pre-cutover instance that carries no keyset commitment', async () => {
    const dto = await createDemo(kit);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const instanceId = `sync-${conn.id}-${conn.nextRunAt}`;
    await run(
      kit.env.DB,
      `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
       VALUES (?, 'connection_sync', ?, ?, 'running', ?)`,
      [instanceId, conn.orgId, conn.id, kit.clock.now()],
    );
    const { sctx, created } = withWorkflow(kit);
    await reconcileConnections(sctx);
    expect(created).toEqual([]);
    kit.clock.advance(31 * 60_000);
    await reconcileConnections(sctx);
    expect(created).toEqual([]);
    expect(await getConnection(kit.env.DB, dto.id)).toMatchObject({
      nextRunAt: kit.clock.now(),
      lastErrorCode: 'RUN_LOST',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
        [instanceId],
      ),
    ).toEqual({ status: 'errored', error_code: 'RUN_LOST' });
    await reconcileConnections(sctx);
    expect(created).toHaveLength(1);
    expect(created[0]?.id).not.toBe(instanceId);
  }, 60_000);
});

describe('dead-letter queue', () => {
  it('acknowledges a deterministic webhook failure and logs the final drop', async () => {
    const { id } = await pushConnection();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handleQueue } = await import('../../jobs/queue.ts');
      const { DLQ_QUEUE } = await import('../../jobs/retry.ts');
      const message = {
        id: 'dlq-missing',
        attempts: 1,
        acked: false,
        retried: false,
        body: {
          kind: 'connection.webhook',
          connectionId: id,
          orgId: kit.org.id,
          generation: 1,
          eventId: 'no-such-event',
          refs: ['a'],
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
        },
        ack() {
          this.acked = true;
        },
        retry() {
          this.retried = true;
        },
      };
      await handleQueue(
        { queue: DLQ_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
        kit.env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(message.acked).toBe(true);
      expect(message.retried).toBe(false);
      const logged = error.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      expect(logged).toContain('queue.dlq_dropped');
      expect(logged).toContain('WEBHOOK_PAYLOAD_MISSING');
    } finally {
      error.mockRestore();
    }
  }, 60_000);
});
