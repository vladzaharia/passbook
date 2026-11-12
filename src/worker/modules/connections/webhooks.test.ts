import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeOrg, makeTemplate, withoutTrigger } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { connectors } from '../../connectors/registry.ts';
import { handleQueue } from '../../jobs/queue.ts';
import { JOBS_QUEUE } from '../../jobs/retry.ts';
import type { Job } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/log.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { getDeps, setDeps } from './deps.ts';
import { retainedById } from './repo-webhook-retention.ts';
import { replaceKeysetForTest, startPendingTransfer } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';
import { processWebhook } from './webhook-process.ts';
import { sweepStalledReplays } from './webhook-redispatch.ts';
import { completeRetainedDispatch } from './webhook-retention.ts';
import { receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
  const template = makeTemplate({ id: kit.templateId, orgId: kit.org.id });
  const release = await approveAppleRelease(
    { ctx: kit.sctx, fx: kit, registry: template.registry },
    { orgId: kit.org.id, templateId: kit.templateId, version: template.resolved.version },
  );
  kit.seams.release = { id: release.id, generation: release.generation, version: release.version };
}, 60_000);

function webhookSecret(dto: { webhookSecret?: string | null }): string {
  if (!dto.webhookSecret) throw new Error('Missing generated webhook secret');
  return dto.webhookSecret;
}

async function pushConn(over: Record<string, unknown> = {}) {
  const dto = await createDemo(kit, {
    connectorType: 'webhook-push',
    config: {},
    mode: 'webhook',
    ...over,
  } as never);
  return { dto, secret: webhookSecret(dto) };
}

async function signedRequest(
  secret: string,
  body: unknown,
  over: { ts?: number; raw?: string } = {},
) {
  const text = over.raw ?? JSON.stringify(body);
  const ts = over.ts ?? Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body: text,
    headers: {
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(secret, ts, text),
    },
  });
}

const event = (id: string, extra: object = {}) => ({
  id,
  records: [
    { ref: 'm-001', record: { memberName: 'Pushed A' } },
    { ref: 'm-002', deleted: true },
  ],
  ...extra,
});

const events = (connectionId: string) =>
  all<{ event_id: string }>(
    kit.env.DB,
    'SELECT event_id FROM webhook_events WHERE connection_id = ?',
    [connectionId],
  );

describe('receiveWebhook', () => {
  it('verifies, encrypts the event records, and queues a job', async () => {
    const { dto, secret } = await pushConn();
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-1')));
    expect(kit.seams.jobs).toEqual([
      {
        kind: 'connection.webhook',
        connectionId: dto.id,
        orgId: kit.org.id,
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        eventId: 'evt-1',
        refs: ['m-001', 'm-002'],
      },
    ]);
    expect((await events(dto.id)).map((e) => e.event_id)).toEqual(['evt-1']);
    expect(
      await all(kit.env.DB, 'SELECT ref FROM connection_inbox WHERE connection_id = ?', [dto.id]),
    ).toEqual([]);
    const retained = await all<{
      id: string;
      state: string;
      credential_keyset_commitment: string;
      ciphertext: string;
      iv: string;
      wrapped_dek: string;
    }>(
      kit.env.DB,
      `SELECT id, state, credential_keyset_commitment, hex(ciphertext) AS ciphertext, hex(iv) AS iv, hex(wrapped_dek) AS wrapped_dek
       FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?`,
      [dto.id, 'evt-1'],
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.state).toBe('pending');
    expect(retained[0]?.credential_keyset_commitment).toBe(kit.credentialKeysetCommitment);
    const retainedId = retained[0]?.id;
    if (!retainedId) throw new Error('Missing retained webhook');
    const stored = await retainedById(kit.env.DB, dto.id, retainedId);
    if (!stored) throw new Error('Missing retained webhook');
    expect((await decryptRetainedPayload(kit.sctx, stored)).credentialKeysetCommitment).toBe(
      kit.credentialKeysetCommitment,
    );
    expect(retained[0]?.ciphertext.length).toBeGreaterThan(0);
    expect(retained[0]?.iv.length).toBeGreaterThan(0);
    expect(retained[0]?.wrapped_dek.length).toBeGreaterThan(0);
    expect(retained[0]?.ciphertext).not.toContain('5075736865642041');
  });

  it('acknowledges a duplicate delivery without queueing it again', async () => {
    const { dto, secret } = await pushConn();
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-d')));
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-d')));
    expect(kit.seams.jobs).toHaveLength(1);
    expect(await events(dto.id)).toHaveLength(1);
  });

  it('rejects a bad signature and records nothing', async () => {
    const { dto } = await pushConn();
    await expect(
      receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest('whsec_wrongwrongwrong1', event('evt-x')),
      ),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE', status: 401 });
    expect(kit.seams.jobs).toEqual([]);
    expect(await events(dto.id)).toEqual([]);
  });

  it('rejects a tampered body', async () => {
    const { dto, secret } = await pushConn();
    const req = await signedRequest(secret, event('evt-t'));
    const body = (await req.clone().text()).replace('Pushed A', 'Pushed B');
    const tampered = new Request(req.url, { method: 'POST', body, headers: req.headers });
    await expect(receiveWebhook(kit.sctx, dto.id, tampered)).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE',
    });
  });

  it('rejects replays outside the window, even with a valid signature', async () => {
    const { dto, secret } = await pushConn();
    const old = Math.floor(kit.clock.now() / 1000) - 600;
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-old'), { ts: old })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
    expect(kit.seams.jobs).toEqual([]);
  });

  it('rejects a signature made with another connection secret', async () => {
    const a = await pushConn();
    const b = await pushConn();
    await expect(
      receiveWebhook(kit.sctx, a.dto.id, await signedRequest(b.secret, event('evt-cross'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
  });

  it('rejects malformed payloads with 400', async () => {
    const { dto, secret } = await pushConn();
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, null, { raw: 'not json' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD', status: 400 });
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, { records: 'x' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD' });
  });

  it('looks identical to a missing connection when disabled, polling-only or unknown', async () => {
    const { dto, secret } = await pushConn();
    const poll = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    for (const id of [dto.id, poll.id, 'no-such-id']) {
      await expect(
        receiveWebhook(kit.sctx, id, await signedRequest(secret, event('evt-n'))),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });

  it('re-dispatches a failed enqueue when the provider redelivers the event', async () => {
    const { dto, secret } = await pushConn();
    kit.seams.failEnqueue = true;
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-q'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_UNAVAILABLE', status: 503 });
    expect(await events(dto.id)).toEqual([{ event_id: 'evt-q' }]);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'evt-q'],
      ),
    ).toEqual({ state: 'failed', error_code: 'WEBHOOK_ENQUEUE_FAILED' });
    kit.seams.failEnqueue = false;
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-q')));
    expect(kit.seams.jobs).toEqual([
      expect.objectContaining({
        kind: 'connection.webhook',
        eventId: 'evt-q',
        refs: ['m-001', 'm-002'],
      }),
    ]);
    expect(await events(dto.id)).toEqual([{ event_id: 'evt-q' }]);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code, dispatch_complete FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'evt-q'],
      ),
    ).toEqual({ state: 'pending', error_code: null, dispatch_complete: 1 });
    // A further delivery is now a plain duplicate.
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-q')));
    expect(kit.seams.jobs).toHaveLength(1);
  });

  it.each(['missing', 'different'] as const)(
    'preserves an uncertain claimed item when enqueue fails after the keyset becomes %s',
    async (sentinel) => {
      const { dto, secret } = await pushConn();
      const pass = await linkedPass(kit, dto.id, 'dispatch-ref');
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]);
      const parentQuery = `SELECT state, error_code, revision, dispatch_complete, credential_keyset_commitment
        FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?`;
      const itemQuery = `SELECT i.state, i.claim_kind, i.claim_pass_id, i.claim_snapshot
        FROM connection_webhook_items i JOIN connection_webhook_retention r ON r.id = i.retention_id
        WHERE r.connection_id = ? AND r.event_id = ?`;
      const parentSnapshots: unknown[] = [];
      const itemSnapshots: unknown[] = [];
      const enqueue = getDeps().enqueueJob;
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      setDeps({
        applyConnectionRecord: async () => {
          throw new Error('simulated uncertain mutation');
        },
        enqueueJob: async (ctx, queued) => {
          await enqueue(ctx, queued);
          if (queued.kind !== 'connection.webhook') throw new Error('Unexpected queue job');
          await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({ status: 503 });
          parentSnapshots.push(
            await first(kit.env.DB, parentQuery, [dto.id, 'dispatch-keyset-race']),
          );
          itemSnapshots.push(await first(kit.env.DB, itemQuery, [dto.id, 'dispatch-keyset-race']));
          await replaceKeysetForTest(kit.sctx, sentinel === 'missing' ? null : other);
          throw new Error('enqueue response lost');
        },
      });
      try {
        await expect(
          receiveWebhook(
            kit.sctx,
            dto.id,
            await signedRequest(secret, {
              id: 'dispatch-keyset-race',
              records: [{ ref: 'dispatch-ref', record: { memberName: 'Private' } }],
            }),
          ),
        ).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' });
        expect(parentSnapshots).toHaveLength(1);
        expect(parentSnapshots[0]).toMatchObject({
          state: 'pending',
          error_code: 'WEBHOOK_DISPATCH_PENDING',
          credential_keyset_commitment: kit.credentialKeysetCommitment,
        });
        expect(itemSnapshots[0]).toMatchObject({
          state: 'uncertain',
          claim_kind: 'existing',
          claim_pass_id: pass.id,
        });
        expect(await first(kit.env.DB, parentQuery, [dto.id, 'dispatch-keyset-race'])).toEqual(
          parentSnapshots[0],
        );
        expect(await first(kit.env.DB, itemQuery, [dto.id, 'dispatch-keyset-race'])).toEqual(
          itemSnapshots[0],
        );
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          before,
        );
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
        ).toEqual(outbox);
        expect(kit.seams.jobs).toHaveLength(1);
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.created).toEqual([]);
      } finally {
        await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
    },
    60_000,
  );

  it('parks a replay stuck pending past the retry horizon as failed, never uncertain, so it can be replayed', async () => {
    const { dto, secret } = await pushConn();
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('stalled-replay')));
    // A replay reserved the chunk (pending, dispatch complete) and its restore never landed.
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_retention SET last_replay_id = 'lost-replay' WHERE connection_id = ?",
      [dto.id],
    );
    expect(await sweepStalledReplays(kit.sctx)).toBe(0);
    kit.clock.advance(61 * 60_000);
    expect(await sweepStalledReplays(kit.sctx)).toBe(0);
    kit.clock.advance(2 * 60 * 60_000);
    expect(await sweepStalledReplays(kit.sctx)).toBe(1);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ?',
        [dto.id],
      ),
    ).toEqual({ state: 'failed', error_code: 'WEBHOOK_REPLAY_STALLED' });
    const items = await all<{ state: string; error_code: string }>(
      kit.env.DB,
      `SELECT i.state, i.error_code FROM connection_webhook_items i
         JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ?`,
      [dto.id],
    );
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every((i) => i.state === 'failed' && i.error_code === 'WEBHOOK_REPLAY_STALLED'),
    ).toBe(true);
    expect(await sweepStalledReplays(kit.sctx)).toBe(0);
  });

  it('does not acknowledge a duplicate when partial enqueue failure could not be recorded', async () => {
    const { dto, secret } = await pushConn();
    const payload = {
      id: 'partial-dispatch',
      records: Array.from({ length: 21 }, (_, i) => ({
        ref: `r-${i}`,
        record: { memberName: `Private member ${i}` },
      })),
    };
    const enqueue = getDeps().enqueueJob;
    let attempts = 0;
    setDeps({
      enqueueJob: async (ctx, item) => {
        attempts += 1;
        if (attempts === 2) throw new Error('queue unavailable');
        return enqueue(ctx, item);
      },
    });
    let failedWrites = 0;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (
              sql.startsWith('UPDATE connection_webhook_retention SET state = ?') &&
              sql.includes('error_code = ?')
            ) {
              failedWrites += 1;
              throw new Error('failure bookkeeping unavailable');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const faulty = { ...kit.sctx, env: { ...kit.env, DB: db } };

    await expect(
      receiveWebhook(faulty, dto.id, await signedRequest(secret, payload)),
    ).rejects.toMatchObject({ status: 503 });
    expect(failedWrites).toBe(1);
    expect(kit.seams.jobs).toHaveLength(1);
    expect(await events(dto.id)).toEqual([{ event_id: 'partial-dispatch' }]);
    const chunks = await all<{ state: string; error_code: string; ciphertext: string }>(
      kit.env.DB,
      `SELECT state, error_code, hex(ciphertext) AS ciphertext FROM connection_webhook_retention
       WHERE connection_id = ? AND event_id = ?`,
      [dto.id, 'partial-dispatch'],
    );
    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          chunk.state === 'pending' &&
          chunk.error_code === 'WEBHOOK_DISPATCH_PENDING' &&
          chunk.ciphertext.length > 0,
      ),
    ).toBe(true);
    expect(
      chunks.every((chunk) => !chunk.ciphertext.includes('50726976617465206D656D626572')),
    ).toBe(true);

    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const response = await app.request(
      `/hooks/connections/${dto.id}`,
      await signedRequest(secret, payload),
      kit.env,
    );
    // The redelivery dispatches every stored chunk again (jobs are idempotent per item claim).
    expect(response.status).toBe(202);
    expect(
      kit.seams.jobs
        .map((job) => (job.kind === 'connection.webhook' ? (job.chunk ?? 0) : -1))
        .sort(),
    ).toEqual([0, 0, 1]);
    expect(
      (
        await all<{ dispatch_complete: number }>(
          kit.env.DB,
          'SELECT dispatch_complete FROM connection_webhook_retention WHERE event_id = ?',
          ['partial-dispatch'],
        )
      ).map((chunk) => chunk.dispatch_complete),
    ).toEqual([1, 1]);
    expect(await events(dto.id)).toEqual([{ event_id: 'partial-dispatch' }]);
  });

  it('retains replayable failure if dispatch completion cannot be persisted', async () => {
    const { dto, secret } = await pushConn();
    let failedWrites = 0;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.startsWith('UPDATE connection_webhook_retention SET dispatch_complete = ?')) {
              failedWrites += 1;
              throw new Error('dispatch completion unavailable');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const faulty = { ...kit.sctx, env: { ...kit.env, DB: db } };
    await expect(
      receiveWebhook(faulty, dto.id, await signedRequest(secret, event('completion-failed'))),
    ).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' });
    expect(failedWrites).toBe(1);
    expect(kit.seams.jobs).toHaveLength(1);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'completion-failed'],
      ),
    ).toEqual({ state: 'failed', error_code: 'WEBHOOK_ENQUEUE_FAILED' });

    // The redelivery queues the stored chunk again and completes the dispatch.
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('completion-failed')));
    expect(kit.seams.jobs).toHaveLength(2);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, dispatch_complete FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'completion-failed'],
      ),
    ).toEqual({ state: 'pending', dispatch_complete: 1 });
  });

  it.each(['keyset', 'chunk-count'] as const)(
    'does not complete dispatch while a signed sibling has a mismatched %s',
    async (corruption) => {
      const { dto, secret } = await pushConn();
      const eventId = 'completion-sibling-fence';
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(secret, {
          id: eventId,
          records: Array.from({ length: 21 }, (_, index) => ({
            ref: `member-${index}`,
            record: { memberName: `Member ${index}` },
          })),
        }),
      );
      expect(kit.seams.jobs).toHaveLength(2);
      const query = `SELECT id, state, error_code, dispatch_complete, chunk_count, credential_keyset_commitment
        FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ? ORDER BY id`;
      const chunks = await all<{ id: string; credential_keyset_commitment: string }>(
        kit.env.DB,
        query,
        [dto.id, eventId],
      );
      expect(chunks).toHaveLength(2);
      expect(
        chunks.every(
          (chunk) => chunk.credential_keyset_commitment === kit.credentialKeysetCommitment,
        ),
      ).toBe(true);
      const sibling = chunks[1];
      if (!sibling) throw new Error('Missing staged sibling');
      await run(
        kit.env.DB,
        `UPDATE connection_webhook_retention
        SET dispatch_complete = 0, error_code = 'WEBHOOK_DISPATCH_PENDING' WHERE connection_id = ? AND event_id = ?`,
        [dto.id, eventId],
      );
      const setSiblingProof = async (proof: string) => {
        const trigger = await first<{ sql: string }>(
          kit.env.DB,
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'connection_webhook_ingress_keyset_immutable'",
        );
        if (!trigger?.sql) throw new Error('Missing ingress keyset immutability guard');
        await run(kit.env.DB, 'DROP TRIGGER connection_webhook_ingress_keyset_immutable');
        try {
          await run(
            kit.env.DB,
            'UPDATE connection_webhook_retention SET credential_keyset_commitment = ? WHERE id = ?',
            [proof, sibling.id],
          );
        } finally {
          await run(kit.env.DB, trigger.sql);
        }
      };
      if (corruption === 'keyset') {
        const other =
          kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        await setSiblingProof(other);
      } else {
        await run(
          kit.env.DB,
          'UPDATE connection_webhook_retention SET chunk_count = 3 WHERE id = ?',
          [sibling.id],
        );
      }
      try {
        const before = await all(kit.env.DB, query, [dto.id, eventId]);
        await expect(
          completeRetainedDispatch(
            kit.sctx,
            kit.org.id,
            dto.id,
            eventId,
            kit.credentialKeysetCommitment,
          ),
        ).rejects.toMatchObject({ code: 'WEBHOOK_DISPATCH_INCOMPLETE' });
        expect(await all(kit.env.DB, query, [dto.id, eventId])).toEqual(before);
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.created).toEqual([]);
      } finally {
        if (corruption === 'keyset') await setSiblingProof(kit.credentialKeysetCommitment);
        else
          await run(
            kit.env.DB,
            'UPDATE connection_webhook_retention SET chunk_count = 2 WHERE id = ?',
            [sibling.id],
          );
      }
      await completeRetainedDispatch(
        kit.sctx,
        kit.org.id,
        dto.id,
        eventId,
        kit.credentialKeysetCommitment,
      );
      const completed = await all<{ dispatch_complete: number; error_code: string | null }>(
        kit.env.DB,
        query,
        [dto.id, eventId],
      );
      expect(completed).toHaveLength(2);
      expect(
        completed.every((chunk) => chunk.dispatch_complete === 1 && chunk.error_code === null),
      ).toBe(true);
    },
    60_000,
  );

  it('uses the rotated secret and drops the old one', async () => {
    const { dto, secret } = await pushConn();
    const { rotateWebhookSecret } = await import('./actions.ts');
    const rotated = await rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    await expect(
      receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-r1'))),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE' });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(rotated.webhookSecret, event('evt-r2')),
    );
    expect(kit.seams.jobs).toHaveLength(1);
  });
});

describe('processWebhook', () => {
  const job = (
    connectionId: string,
    eventId: string,
    refs: string[],
  ): Job & { kind: 'connection.webhook' } => ({
    kind: 'connection.webhook',
    connectionId,
    orgId: kit.org.id,
    generation: 1,
    eventId,
    refs,
  });

  it('applies pushed records, deletions and auto-created passes, and records a webhook run', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      onMissing: 'void',
    });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    const p2 = await linkedPass(kit, dto.id, 'm-002');
    const passProof = await first<{
      identity_id: string;
      credential_generation: number;
      lifecycle_generation: number;
      template_id: string;
      template_version: string;
      release_id: string | null;
    }>(
      kit.env.DB,
      `SELECT identity_id, credential_generation, lifecycle_generation, template_id, template_version, release_id
      FROM passes WHERE id = ?`,
      [p1.id],
    );
    if (!passProof) throw new Error('Missing linked pass proof');
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'evt-p',
        records: [
          { ref: 'm-001', record: { memberName: 'Pushed A' } },
          { ref: 'm-002', deleted: true },
          { ref: 'm-003', record: { memberName: 'Brand new' } },
        ],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: p1.id,
      expectedConnectionMode: 'webhook',
      identityId: passProof.identity_id,
      credentialGeneration: passProof.credential_generation,
      lifecycleGeneration: passProof.lifecycle_generation,
      transferPending: false,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      retainedBinding: {
        templateId: passProof.template_id,
        templateVersion: passProof.template_version,
        releaseId: passProof.release_id,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      },
      fields: { memberName: 'Pushed A' },
    });
    expect(kit.seams.missing).toEqual([{ passId: p2.id, mode: 'void' }]);
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['m-003']);
    expect(kit.seams.created[0]).toEqual({
      orgId: kit.org.id,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      mode: 'live',
      templateId: kit.templateId,
      expectedRelease: { ...kit.seams.release },
      connectionId: dto.id,
      generation: 1,
      expectedConnectionMode: 'webhook',
      externalRef: 'm-003',
      fields: { memberName: 'Brand new' },
      holderEmail: null,
      sendEmail: false,
      reservedPassId: expect.any(String),
      retainedClaim: {
        retentionId: expect.any(String),
        ordinal: 2,
        token: expect.any(String),
        revision: expect.any(Number),
        refHash: expect.any(String),
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      },
    });
    const creation = kit.seams.created[0];
    if (!creation?.retainedClaim || !creation.reservedPassId)
      throw new Error('Missing issuance claim');
    const claim = await first<{ state: string; claim_pass_id: string; claim_snapshot: string }>(
      kit.env.DB,
      'SELECT state, claim_pass_id, claim_snapshot FROM connection_webhook_items WHERE retention_id = ? AND ordinal = ?',
      [creation.retainedClaim.retentionId, creation.retainedClaim.ordinal],
    );
    expect(claim).toMatchObject({ state: 'success', claim_pass_id: creation.reservedPassId });
    expect(JSON.parse(claim?.claim_snapshot ?? 'null')).toMatchObject({
      kind: 'new',
      passId: creation.reservedPassId,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
    });
    const run = await first<{ trigger: string; outcome: string; records_seen: number }>(
      kit.env.DB,
      "SELECT trigger, outcome, records_seen FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
      [dto.id],
    );
    expect(run).toEqual({ trigger: 'webhook', outcome: 'changed', records_seen: 3 });
  });

  it('keeps the ingress keyset and original pass claim when the keyset changes during a fetch', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const pass = await linkedPass(kit, dto.id, 'keyset-ref');
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(webhookSecret(dto), {
        id: 'keyset-fetch-race',
        refs: ['keyset-ref'],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('Missing staged job');
    expect(queued.credentialKeysetCommitment).toBe(kit.credentialKeysetCommitment);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
      kit.org.id,
    ]);
    const other =
      kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    let fetches = 0;
    setDeps({
      fetchImpl: (async () => {
        fetches += 1;
        await replaceKeysetForTest(kit.sctx, other);
        return new Response(JSON.stringify({ memberName: 'Must not apply' }));
      }) as typeof fetch,
    });
    try {
      await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({ status: 503 });
      expect(fetches).toBe(1);
      const item = await first<{ state: string; claim_pass_id: string; claim_snapshot: string }>(
        kit.env.DB,
        `SELECT i.state, i.claim_pass_id, i.claim_snapshot FROM connection_webhook_items i
          JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ? AND r.event_id = ?`,
        [dto.id, queued.eventId],
      );
      expect(item).toMatchObject({ state: 'started', claim_pass_id: pass.id });
      expect(JSON.parse(item?.claim_snapshot ?? 'null')).toMatchObject({
        passId: pass.id,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      });
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
      ).toEqual(outbox);
    } finally {
      await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
    }
    await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({ status: 503 });
    expect(fetches).toBe(1);
    expect(kit.seams.applied).toEqual([]);
  }, 60_000);

  it.each([1, 8])(
    'logs and retains a baseline-shaped queue message as ignored (attempt %s) without running it',
    async (attempts) => {
      const { dto } = await pushConn();
      const pass = await linkedPass(kit, dto.id, 'legacy-ref');
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [dto.id, 'legacy-event', kit.clock.now()],
      );
      await run(
        kit.env.DB,
        `INSERT INTO connection_inbox (connection_id, event_id, ref, record, deleted, received_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
        [
          dto.id,
          'legacy-event',
          'legacy-ref',
          JSON.stringify({ memberName: 'Legacy' }),
          kit.clock.now(),
        ],
      );

      // The pre-cutover Worker queued no orgId, generation or keyset commitment.
      const message = {
        id: 'legacy-queue-message',
        body: {
          kind: 'connection.webhook',
          connectionId: dto.id,
          eventId: 'legacy-event',
          refs: ['legacy-ref'],
        },
        attempts,
        acked: false,
        retried: null as { delaySeconds?: number } | null,
        ack() {
          this.acked = true;
        },
        retry(options?: { delaySeconds?: number }) {
          this.retried = options ?? {};
        },
      };
      const lines: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => {
        lines.push(line);
      });
      try {
        await handleQueue(
          { queue: JOBS_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
          kit.env,
          createExecutionContext(),
        );
      } finally {
        warn.mockRestore();
      }
      expect(message.acked).toBe(true);
      expect(message.retried).toBeNull();
      expect(lines.join('\n')).toContain('queue.legacy_job_ignored');

      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code, source FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'legacy-event'],
        ),
      ).toEqual({ state: 'ignored', error_code: 'WEBHOOK_LEGACY_JOB', source: 'legacy' });
      // Terminal and unbound: it never runs, so it must not fence the organization's transfers.
      expect(
        await first(
          kit.env.DB,
          `SELECT i.state, i.prior_unknown, i.claim_pass_id, i.claim_prior_unbound FROM connection_webhook_items i
       JOIN connection_webhook_retention r ON r.id = i.retention_id
       WHERE r.connection_id = ? AND r.event_id = ?`,
          [dto.id, 'legacy-event'],
        ),
      ).toEqual({
        state: 'failed',
        prior_unknown: 1,
        claim_pass_id: null,
        claim_prior_unbound: 0,
      });
      await startPendingTransfer(kit.sctx, pass.id);
    },
  );

  it('acknowledges a baseline-shaped pass.refresh message without running it', async () => {
    const message = {
      id: 'legacy-refresh',
      body: { kind: 'pass.refresh', passId: 'p1', trigger: 'admin', actorId: null },
      attempts: 1,
      acked: false,
      retried: null as { delaySeconds?: number } | null,
      ack() {
        this.acked = true;
      },
      retry(options?: { delaySeconds?: number }) {
        this.retried = options ?? {};
      },
    };
    await handleQueue(
      { queue: JOBS_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
      kit.env,
      createExecutionContext(),
    );
    expect(message.acked).toBe(true);
    expect(message.retried).toBeNull();
  });

  it.each(['TEMPLATE_RELEASE_REQUIRED', 'TEMPLATE_RELEASE_CONFLICT'] as const)(
    'durably blocks and acknowledges a webhook when %s prevents creation',
    async (code) => {
      const { dto, secret } = await pushConn({
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      });
      const resolveRelease = getDeps().requireApprovedRelease;
      let missing = code === 'TEMPLATE_RELEASE_REQUIRED';
      let lookups = 0;
      setDeps({
        requireApprovedRelease: async (...args) => {
          lookups += 1;
          if (missing) throw new ConflictError('No approved release.', code);
          return resolveRelease(...args);
        },
      });
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(secret, {
          id: 'release-blocked',
          records: [{ ref: 'm-001', record: { memberName: 'Pushed A' } }],
        }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');
      expect(lookups).toBe(1);
      if (code === 'TEMPLATE_RELEASE_CONFLICT') {
        kit.seams.release = { ...kit.seams.release, id: 'replacement-release', generation: 2 };
      }
      const dispatch = async (attempts: number) => {
        const message = {
          id: 'webhook-message',
          body: queued,
          attempts,
          acked: false,
          retried: null as { delaySeconds?: number } | null,
          ack() {
            this.acked = true;
          },
          retry(options?: { delaySeconds?: number }) {
            this.retried = options ?? {};
          },
        };
        await handleQueue(
          { queue: JOBS_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
          kit.env,
          createExecutionContext(),
        );
        return message;
      };

      const blocked = await dispatch(1);
      expect(blocked.acked).toBe(true);
      expect(blocked.retried).toBeNull();
      expect(lookups).toBe(code === 'TEMPLATE_RELEASE_REQUIRED' ? 1 : 2);
      expect(kit.seams.createAttempts).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'release-blocked'],
        ),
      ).toEqual({ state: 'blocked', error_code: code });

      // Queue redelivery must not adopt a newly available release; only explicit replay may do so.
      missing = false;
      const duplicate = await dispatch(2);
      expect(duplicate.acked).toBe(true);
      expect(duplicate.retried).toBeNull();
      expect(lookups).toBe(code === 'TEMPLATE_RELEASE_REQUIRED' ? 1 : 2);
      expect(kit.seams.created).toEqual([]);
      const snapshot = await first(
        kit.env.DB,
        'SELECT state, error_code, release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'release-blocked'],
      );
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(secret, {
          id: 'release-blocked',
          records: [{ ref: 'm-001', record: { memberName: 'Pushed A' } }],
        }),
      );
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code, release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'release-blocked'],
        ),
      ).toEqual(snapshot);
      expect(kit.seams.jobs).toHaveLength(1);
      expect(await events(dto.id)).toEqual([{ event_id: 'release-blocked' }]);
    },
  );

  it('treats pass-service validation failure as uncertain without exposing samples', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/missing' } },
    });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'invalid-private',
        records: [{ ref: 'private-ref', record: { memberName: 'Private member' } }],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');

    await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
    expect(kit.seams.createAttempts).toHaveLength(1);
    expect(kit.seams.created).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT error_code, error_detail FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
        [dto.id],
      ),
    ).toEqual({ error_code: 'INTERNAL', error_detail: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'invalid-private'],
      ),
    ).toEqual({ state: 'failed', error_code: 'WEBHOOK_EFFECT_UNCERTAIN' });
  });

  it('retains pre-apply record errors without exposing webhook samples in run details', async () => {
    setDeps({ fetchImpl: (async () => new Response('not json', { status: 200 })) as typeof fetch });
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(webhookSecret(dto), { id: 'invalid-payload', refs: ['private-ref'] }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
    expect(kit.seams.createAttempts).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT error_code, error_detail FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
        [dto.id],
      ),
    ).toEqual({ error_code: 'RECORD_ERRORS', error_detail: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'invalid-payload'],
      ),
    ).toEqual({ state: 'failed', error_code: 'RECORD_ERRORS' });
  });

  it('updates an existing pass even when a new ref is blocked on approval', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      maxConcurrency: 1,
    });
    const existing = await linkedPass(kit, dto.id, 'existing');
    setDeps({
      requireApprovedRelease: async () => {
        throw new ConflictError('No approved release.', 'TEMPLATE_RELEASE_REQUIRED');
      },
    });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'mixed-release-block',
        records: [
          { ref: 'existing', record: { memberName: 'Updated member' } },
          { ref: 'new', record: { memberName: 'New member' } },
        ],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');

    await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([existing.id]);
    expect(kit.seams.created).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT outcome, error_code, passes_changed FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
        [dto.id],
      ),
    ).toEqual({ outcome: 'error', error_code: 'TEMPLATE_RELEASE_REQUIRED', passes_changed: 1 });
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'mixed-release-block'],
      ),
    ).toEqual({ state: 'blocked', error_code: 'TEMPLATE_RELEASE_REQUIRED' });
  });

  it.each([false, true])(
    'preserves a release block alongside a pass race unless the connection is stale (%s)',
    async (staleConnection) => {
      const { dto, secret } = await pushConn({
        autoCreate: true,
        defaultTemplateId: kit.templateId,
        maxConcurrency: 1,
      });
      const existing = await linkedPass(kit, dto.id, 'existing');
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [existing.id]);
      let updateAttempts = 0;
      setDeps({
        requireApprovedRelease: async () => {
          throw new ConflictError('No approved release.', 'TEMPLATE_RELEASE_REQUIRED');
        },
        applyConnectionRecord: async () => {
          updateAttempts += 1;
          if (staleConnection) {
            await run(
              kit.env.DB,
              'UPDATE connections SET generation = generation + 1 WHERE id = ?',
              [dto.id],
            );
          }
          throw new ConflictError('The pass changed.', 'PASS_CONFLICT');
        },
      });
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(secret, {
          id: 'blocked-and-raced',
          records: [
            { ref: 'new', record: { memberName: 'New' } },
            { ref: 'existing', record: { memberName: 'Existing' } },
          ],
        }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');

      if (staleConnection) {
        await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
      } else {
        // A CAS loss wrote nothing: its item returns to pending and the job is retried.
        await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({
          code: 'WEBHOOK_ITEM_PENDING',
        });
      }
      expect(updateAttempts).toBe(1);
      expect(kit.seams.created).toEqual([]);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [existing.id])).toEqual(
        before,
      );
      if (!staleConnection) {
        expect(
          await all(
            kit.env.DB,
            `SELECT i.ordinal, i.state FROM connection_webhook_items i
             JOIN connection_webhook_retention r ON r.id = i.retention_id
             WHERE r.connection_id = ? AND r.event_id = ? ORDER BY i.ordinal`,
            [dto.id, 'blocked-and-raced'],
          ),
        ).toEqual([
          { ordinal: 0, state: 'blocked' },
          { ordinal: 1, state: 'pending' },
        ]);
        return;
      }
      expect(
        await first(
          kit.env.DB,
          "SELECT outcome, error_code FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
          [dto.id],
        ),
      ).toEqual({ outcome: 'skipped', error_code: 'STALE_GENERATION' });
    },
  );

  it.each([false, true])(
    'handles unexpected apply failures safely and retries only live context (%s)',
    async (staleConnection) => {
      const { dto, secret } = await pushConn({
        autoCreate: true,
        defaultTemplateId: kit.templateId,
        maxConcurrency: 1,
      });
      await linkedPass(kit, dto.id, 'existing');
      const captured = { ...kit.seams.release };
      const apply = getDeps().applyConnectionRecord;
      const privateError = 'Raw upstream failure with private member data';
      const logs: string[] = [];
      const sctx = {
        ...kit.sctx,
        log: createLogger(
          {},
          {
            sink: (line) => {
              logs.push(line);
            },
          },
        ),
      };
      setDeps({
        applyConnectionRecord: async () => {
          if (staleConnection) {
            await run(
              kit.env.DB,
              'UPDATE connections SET generation = generation + 1 WHERE id = ?',
              [dto.id],
            );
          }
          throw new Error(privateError);
        },
      });
      await receiveWebhook(
        sctx,
        dto.id,
        await signedRequest(secret, {
          id: 'apply-failed',
          records: [
            { ref: 'existing', record: { memberName: 'Private member data' } },
            { ref: 'new', record: { memberName: 'New member' } },
          ],
        }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');

      const processing = processWebhook(sctx, queued);
      if (staleConnection) {
        await expect(processing).resolves.toBeUndefined();
      } else {
        await expect(processing).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_INTERNAL' });
      }
      const runRow = await first(
        kit.env.DB,
        "SELECT outcome, error_code, error_detail, finished_at FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
        [dto.id],
      );
      expect(runRow).toMatchObject(
        staleConnection
          ? { outcome: 'skipped', error_detail: null, finished_at: expect.any(Number) }
          : {
              outcome: 'error',
              error_code: 'INTERNAL',
              error_detail: null,
              finished_at: expect.any(Number),
            },
      );
      expect(JSON.stringify([runRow, logs])).not.toContain(privateError);
      expect(JSON.stringify([runRow, logs])).not.toContain('Private member data');
      const retained = await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'apply-failed'],
      );
      if (staleConnection) {
        expect(retained).toEqual({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
        return;
      }
      expect(retained).toMatchObject({ state: 'pending' });
      kit.seams.release = { ...captured, id: 'replacement-release', generation: 2 };
      setDeps({ applyConnectionRecord: apply });
      await expect(processWebhook(sctx, queued)).resolves.toBeUndefined();
      expect(kit.seams.releaseLookups).toHaveLength(3);
      expect(kit.seams.createAttempts).toEqual([]);
      const stored = await first<{ release_snapshot: string }>(
        kit.env.DB,
        'SELECT release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'apply-failed'],
      );
      expect(JSON.parse(stored?.release_snapshot ?? 'null')).toEqual({
        kind: 'approved',
        ...captured,
      });
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'apply-failed'],
        ),
      ).toEqual({ state: 'blocked', error_code: 'TEMPLATE_RELEASE_CONFLICT' });
    },
  );

  it.each([false, true])(
    'retries a failed approval comparison without recapturing its stored snapshot (%s)',
    async (staleConnection) => {
      const { dto, secret } = await pushConn({
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      });
      const captured = { ...kit.seams.release };
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(secret, {
          id: 'comparison-failed',
          records: [{ ref: 'new', record: { memberName: 'New' } }],
        }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');
      const resolveRelease = getDeps().requireApprovedRelease;
      setDeps({
        requireApprovedRelease: async () => {
          if (staleConnection) {
            await run(
              kit.env.DB,
              'UPDATE connections SET generation = generation + 1 WHERE id = ?',
              [dto.id],
            );
          }
          throw new Error('Private release lookup error');
        },
      });
      const logs: string[] = [];
      const sctx = {
        ...kit.sctx,
        log: createLogger(
          {},
          {
            sink: (line) => {
              logs.push(line);
            },
          },
        ),
      };
      const processing = processWebhook(sctx, queued);
      if (staleConnection) {
        await expect(processing).resolves.toBeUndefined();
      } else {
        await expect(processing).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_INTERNAL' });
      }
      const row = await first<{
        state: string;
        error_code: string | null;
        release_snapshot: string;
      }>(
        kit.env.DB,
        'SELECT state, error_code, release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'comparison-failed'],
      );
      expect(JSON.parse(row?.release_snapshot ?? 'null')).toEqual({
        kind: 'approved',
        ...captured,
      });
      expect(JSON.stringify(logs)).not.toContain('Private release lookup error');
      const runRow = await first(
        kit.env.DB,
        "SELECT outcome, error_code, error_detail, finished_at FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
        [dto.id],
      );
      expect(runRow).toMatchObject(
        staleConnection
          ? { outcome: 'skipped', error_detail: null, finished_at: expect.any(Number) }
          : {
              outcome: 'error',
              error_code: 'INTERNAL',
              error_detail: null,
              finished_at: expect.any(Number),
            },
      );
      if (staleConnection) {
        expect(row).toMatchObject({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
        return;
      }
      expect(row).toMatchObject({ state: 'pending' });
      setDeps({ requireApprovedRelease: resolveRelease });
      await processWebhook(sctx, queued);
      expect(kit.seams.created[0]?.expectedRelease).toEqual(captured);
    },
  );

  it.each([false, true])(
    'rejects ingress when release capture fails or the connection changes during it (%s)',
    async (staleConnection) => {
      const { dto, secret } = await pushConn({
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      });
      const resolveRelease = getDeps().requireApprovedRelease;
      setDeps({
        requireApprovedRelease: async (...args) => {
          if (!staleConnection) throw new Error('Release database unavailable');
          await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
            dto.id,
          ]);
          return resolveRelease(...args);
        },
      });

      await expect(
        receiveWebhook(
          kit.sctx,
          dto.id,
          await signedRequest(secret, {
            id: 'lookup-failed',
            records: [{ ref: 'new', record: { memberName: 'New' } }],
          }),
        ),
      ).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' });
      expect(await events(dto.id)).toEqual([]);
      expect(
        await all(
          kit.env.DB,
          'SELECT id FROM connection_webhook_retention WHERE connection_id = ?',
          [dto.id],
        ),
      ).toEqual([]);
      expect(kit.seams.jobs).toEqual([]);
    },
  );

  it('retains the original release through transient retries and blocks a replaced release', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/memberName' } },
    } as never);
    const captured = { ...kit.seams.release };
    let fetches = 0;
    setDeps({
      fetchImpl: (async () => {
        fetches += 1;
        expect(kit.seams.releaseLookups).toHaveLength(fetches + 1);
        return fetches === 1
          ? new Response('unavailable', { status: 503 })
          : new Response(JSON.stringify({ memberName: 'Fetched' }), { status: 200 });
      }) as typeof fetch,
    });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(webhookSecret(dto), { id: 'release-fetch', refs: ['r9'] }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({
      code: 'WEBHOOK_UPSTREAM',
    });
    kit.seams.release = { ...captured, id: 'replacement-release', generation: 2 };
    await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
    expect(fetches).toBe(2);
    expect(kit.seams.releaseLookups).toHaveLength(3);
    expect(kit.seams.createAttempts).toEqual([]);
    const stored = await first<{ release_snapshot: string }>(
      kit.env.DB,
      'SELECT release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
      [dto.id, 'release-fetch'],
    );
    expect(JSON.parse(stored?.release_snapshot ?? 'null')).toEqual({
      kind: 'approved',
      ...captured,
    });
    expect(kit.seams.created).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'release-fetch'],
      ),
    ).toEqual({ state: 'blocked', error_code: 'TEMPLATE_RELEASE_CONFLICT' });
  });

  it('retries changed template content with the same ingress-pinned release', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    const captured = { ...kit.seams.release };
    const seen: unknown[] = [];
    setDeps({
      createPassFromConnection: async (_ctx, input) => {
        seen.push(input.expectedRelease);
        throw new ConflictError('Template bytes changed.', 'TEMPLATE_CONTENT_CHANGED');
      },
    });
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'content-changed',
        records: [{ ref: 'new', record: { memberName: 'Member' } }],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');

    await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({
      status: 503,
      code: 'WEBHOOK_UPSTREAM',
    });
    await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({
      status: 503,
      code: 'WEBHOOK_UPSTREAM',
    });
    expect(seen).toEqual([captured, captured]);
    expect(kit.seams.releaseLookups).toHaveLength(3);
    expect(kit.seams.created).toEqual([]);
    const retained = await first<{ state: string; error_code: string; release_snapshot: string }>(
      kit.env.DB,
      'SELECT state, error_code, release_snapshot FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
      [dto.id, 'content-changed'],
    );
    expect(retained).toMatchObject({ state: 'pending' });
    expect(JSON.parse(retained?.release_snapshot ?? 'null')).toEqual({
      kind: 'approved',
      ...captured,
    });
    const runs = await all<{
      outcome: string;
      error_code: string | null;
      error_detail: string | null;
    }>(
      kit.env.DB,
      "SELECT outcome, error_code, error_detail FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
      [dto.id],
    );
    expect(runs).toHaveLength(2);
    expect(runs.every((row) => row.outcome === 'error' && row.error_code === 'UPSTREAM')).toBe(
      true,
    );
    expect(runs.every((row) => row.error_detail === null)).toBe(true);
  });

  it('ignores events for deleted or disabled connections', async () => {
    const { dto } = await pushConn();
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    await processWebhook(kit.sctx, job(dto.id, 'e', ['a']));
    await processWebhook(kit.sctx, job('gone', 'e', ['a']));
    expect(kit.seams.applied).toEqual([]);
  });

  it.each([
    ['before-claim', 'existing'],
    ['during-fetch', 'existing'],
    ['during-fetch', 'new'],
  ] as const)(
    'ACKs a mode change %s for an %s reference without pass or health effects',
    async (phase, binding) => {
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
        mode: 'hybrid',
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      } as never);
      if (binding === 'existing') await linkedPass(kit, dto.id, 'mode-race');
      let switches = 0;
      let fetches = 0;
      const switchMode = async () => {
        switches += 1;
        await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [dto.id]);
      };
      setDeps({
        fetchImpl: (async () => {
          fetches += 1;
          if (phase === 'during-fetch') await switchMode();
          return new Response(JSON.stringify({ memberName: 'Must not publish' }), { status: 200 });
        }) as typeof fetch,
      });
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(webhookSecret(dto), { id: 'mode-in-flight', refs: ['mode-race'] }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('Missing staged job');
      const passesBefore = await all(
        kit.env.DB,
        'SELECT * FROM passes WHERE connection_id = ? ORDER BY id',
        [dto.id],
      );
      const outboxBefore = await all(
        kit.env.DB,
        'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
        [kit.org.id],
      );
      const healthQuery = `SELECT health, consecutive_failures, breaker_open_until, cursor,
        next_run_at, last_run_at, last_success_at, last_error_code, last_error_at FROM connections WHERE id = ?`;
      const healthBefore = await first(kit.env.DB, healthQuery, [dto.id]);
      const statements = new WeakMap<
        D1PreparedStatement,
        { sql: string; args: unknown[]; target: D1PreparedStatement }
      >();
      const wrap = (
        statement: D1PreparedStatement,
        sql: string,
        args: unknown[] = [],
      ): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'bind')
              return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        statements.set(proxy, { sql, args, target: statement });
        return proxy;
      };
      const db = new Proxy(kit.env.DB, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
          if (property === 'batch')
            return async (batch: D1PreparedStatement[]) => {
              // The claim is one grant batch whose item update sets state to 'started'.
              if (
                phase === 'before-claim' &&
                switches === 0 &&
                batch.some((statement) => {
                  const known = statements.get(statement);
                  return (
                    known?.sql.startsWith('UPDATE connection_webhook_items SET') &&
                    known.args[0] === 'started'
                  );
                })
              )
                await switchMode();
              return target.batch(
                batch.map((statement) => statements.get(statement)?.target ?? statement),
              );
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const message = {
        id: 'mode-in-flight',
        body: queued,
        attempts: 1,
        acked: false,
        retried: null as { delaySeconds?: number } | null,
        ack() {
          this.acked = true;
        },
        retry(options?: { delaySeconds?: number }) {
          this.retried = options ?? {};
        },
      };
      await handleQueue(
        { queue: JOBS_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
        { ...kit.env, DB: db },
        createExecutionContext(),
      );

      expect(switches).toBe(1);
      expect(fetches).toBe(phase === 'during-fetch' ? 1 : 0);
      expect(message.acked).toBe(true);
      expect(message.retried).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT mode, generation FROM connections WHERE id = ?', [dto.id]),
      ).toEqual({ mode: 'webhook', generation: 2 });
      expect(await first(kit.env.DB, healthQuery, [dto.id])).toEqual(healthBefore);
      expect(
        await all(kit.env.DB, 'SELECT * FROM passes WHERE connection_id = ? ORDER BY id', [dto.id]),
      ).toEqual(passesBefore);
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
      ).toEqual(outboxBefore);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'mode-in-flight'],
        ),
      ).toEqual({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
    },
  );

  it('hybrid: fetches the refs named by the webhook through the connector', async () => {
    const fetched: string[] = [];
    setDeps({
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ memberName: 'Fetched' }), { status: 200 });
      }) as typeof fetch,
    });
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'r9');
    const req = await signedRequest(webhookSecret(dto), { id: 'evt-h', refs: ['r9'] });
    await receiveWebhook(kit.sctx, dto.id, req);
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(fetched).toEqual(['https://api.example.com/m/r9']);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: pass.id,
      expectedConnectionMode: 'hybrid',
      fields: { memberName: 'Fetched' },
    });
  });

  it.each(['reference-mode', 'missing-verifier'] as const)(
    'fails retained work without fetching when %s no longer matches',
    async (change) => {
      const requests: string[] = [];
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Fetched' }), { status: 200 });
        }) as typeof fetch,
      });
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
        mode: 'hybrid',
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      } as never);
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      await receiveWebhook(
        kit.sctx,
        dto.id,
        await signedRequest(webhookSecret(dto), {
          id: 'reference-fence',
          refs: ['m-001', 'm-002'],
        }),
      );
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');
      expect(
        await first(
          kit.env.DB,
          'SELECT reference_mode FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, 'reference-fence'],
        ),
      ).toEqual({ reference_mode: 'refs-only' });
      if (change === 'reference-mode') {
        await run(
          kit.env.DB,
          "UPDATE connection_webhook_retention SET reference_mode = 'embedded-required' WHERE connection_id = ? AND event_id = ?",
          [dto.id, 'reference-fence'],
        );
      } else {
        // Demo declares refs-only metadata but has no webhook verifier. The generation bump is
        // suspended so that this fence, not the generation fence, is the one exercised.
        await withoutTrigger(kit.env.DB, 'connections_generation_bump', () =>
          run(kit.env.DB, "UPDATE connections SET connector_type = 'demo' WHERE id = ?", [dto.id]),
        );
      }
      const demo = connectors.get('demo');
      if (!demo) throw new Error('Missing demo connector');
      const demoFetch = vi.spyOn(demo, 'fetchRecord');
      try {
        await expect(processWebhook(kit.sctx, queued)).resolves.toBeUndefined();
        expect(requests).toEqual([]);
        expect(demoFetch).not.toHaveBeenCalled();
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.created).toEqual([]);
        expect(kit.seams.missing).toEqual([]);
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          before,
        );
        expect(
          await first(
            kit.env.DB,
            'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
            [dto.id, 'reference-fence'],
          ),
        ).toEqual({ state: 'failed', error_code: 'WEBHOOK_REFERENCE_MODE_CHANGED' });
      } finally {
        demoFetch.mockRestore();
      }
    },
  );

  it('records connector failures without touching passes', async () => {
    setDeps({ fetchImpl: (async () => new Response('x', { status: 401 })) as typeof fetch });
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
    } as never);
    await linkedPass(kit, dto.id, 'r9');
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(webhookSecret(dto), { id: 'e', refs: ['r9'] }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied).toEqual([]);
    const run = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      "SELECT outcome, error_code FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
      [dto.id],
    );
    expect(run).toEqual({ outcome: 'error', error_code: 'AUTH' });
  });

  it('does not apply records to passes of another org', async () => {
    const { dto, secret } = await pushConn();
    const other = await makeOrg(kit);
    const theirs = await linkedPass(kit, dto.id, 'm-001', other.id);
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('evt-iso')));
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied.map((a) => a.passId)).not.toContain(theirs.id);
  });

  it('ignores legacy Test, voided, deleted and removed bindings while syncing Live passes', async () => {
    const { dto, secret } = await pushConn({
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      onMissing: 'void',
    });
    const test = await linkedPass(kit, dto.id, 'test-ref', kit.org.id, 'test');
    const voided = await linkedPass(kit, dto.id, 'voided-ref');
    const deleted = await linkedPass(kit, dto.id, 'deleted-ref');
    const removed = await linkedPass(kit, dto.id, 'removed-ref');
    const live = await linkedPass(kit, dto.id, 'live-ref');
    const quarantined = await linkedPass(kit, dto.id, 'quarantined-ref');
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [deleted.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantined.id,
    ]);
    const before = await all(
      kit.env.DB,
      'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id',
      [test.id, voided.id, deleted.id, removed.id, quarantined.id],
    );
    await receiveWebhook(
      kit.sctx,
      dto.id,
      await signedRequest(secret, {
        id: 'legacy-bindings',
        records: [
          { ref: 'test-ref', record: { memberName: 'Test must not change' } },
          { ref: 'voided-ref', deleted: true },
          { ref: 'deleted-ref', record: { memberName: 'Deleted' } },
          { ref: 'removed-ref', deleted: true },
          { ref: 'quarantined-ref', record: { memberName: 'Quarantined' } },
          { ref: 'live-ref', record: { memberName: 'Updated' } },
        ],
      }),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    await processWebhook(kit.sctx, queued);
    expect(
      await all(kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id', [
        test.id,
        voided.id,
        deleted.id,
        removed.id,
        quarantined.id,
      ]),
    ).toEqual(before);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([live.id]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
  });

  it('does not resolve another organization’s retained webhook for a forged stale job', async () => {
    const { dto, secret } = await pushConn();
    const pass = await linkedPass(kit, dto.id, 'm-001');
    await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('org-fence')));
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('no job');
    const query = `SELECT state, error_code, hex(ciphertext) AS ciphertext FROM connection_webhook_retention
      WHERE connection_id = ? AND event_id = ?`;
    const before = await first(kit.env.DB, query, [dto.id, 'org-fence']);
    expect(before).toMatchObject({ state: 'pending' });

    const other = await makeOrg(kit);
    await expect(processWebhook(kit.sctx, { ...queued, orgId: other.id })).resolves.toBeUndefined();
    expect(await first(kit.env.DB, query, [dto.id, 'org-fence'])).toEqual(before);
    expect(kit.seams.applied).toEqual([]);

    await processWebhook(kit.sctx, queued);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([pass.id]);
  });

  it.each(['generation', 'disabled', 'mode', 'org', 'missing-context'] as const)(
    'rejects a queued webhook with stale %s before applying it',
    async (change) => {
      const { dto, secret } = await pushConn();
      const pass = await linkedPass(kit, dto.id, 'm-001');
      await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('queued')));
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('no job');
      if (change === 'generation') {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          dto.id,
        ]);
      } else if (change === 'disabled') {
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [dto.id]);
      } else if (change === 'mode') {
        await run(kit.env.DB, "UPDATE connections SET mode = 'manual' WHERE id = ?", [dto.id]);
      } else if (change === 'org') {
        queued.orgId = (await makeOrg(kit)).id;
      } else {
        delete (queued as Partial<typeof queued>).generation;
      }
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      await processWebhook(kit.sctx, queued);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
      const retained = await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'queued'],
      );
      if (change === 'org' || change === 'missing-context') {
        expect(retained).toMatchObject({ state: 'pending' });
      } else {
        expect(retained).toEqual({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
      }
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
          [dto.id],
        ),
      ).toEqual([]);
    },
  );
  it.each(['generation', 'mode', 'disabled', 'org-moved', 'org-suspended'] as const)(
    'ACKs stale queued work after %s changes without effects',
    async (change) => {
      const { dto, secret } = await pushConn();
      const pass = await linkedPass(kit, dto.id, 'm-001');
      await receiveWebhook(kit.sctx, dto.id, await signedRequest(secret, event('stale-queue')));
      const queued = kit.seams.jobs[0];
      if (queued?.kind !== 'connection.webhook') throw new Error('Missing staged job');
      const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const before = await first<{ ciphertext: string }>(
        kit.env.DB,
        'SELECT hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE connection_id = ?',
        [dto.id],
      );
      if (!before) throw new Error('Missing retained webhook');
      if (change === 'generation') {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          dto.id,
        ]);
      } else if (change === 'mode') {
        await run(kit.env.DB, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [dto.id]);
      } else if (change === 'disabled') {
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [dto.id]);
      } else if (change === 'org-moved') {
        const other = await makeOrg(kit);
        await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [other.id, dto.id]);
      } else {
        await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      }

      for (const attempts of [1, 8]) {
        const message = {
          id: `stale-queue-${attempts}`,
          body: queued,
          attempts,
          acked: false,
          retried: null as { delaySeconds?: number } | null,
          ack() {
            this.acked = true;
          },
          retry(options?: { delaySeconds?: number }) {
            this.retried = options ?? {};
          },
        };
        await handleQueue(
          { queue: JOBS_QUEUE, messages: [message] } as unknown as MessageBatch<unknown>,
          kit.env,
          createExecutionContext(),
        );
        expect(message.acked).toBe(true);
        expect(message.retried).toBeNull();
      }
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code, hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE connection_id = ?',
          [dto.id],
        ),
      ).toEqual({
        state: 'ignored',
        error_code: 'WEBHOOK_STALE_CONTEXT',
        ciphertext: before.ciphertext,
      });
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        passBefore,
      );
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM connection_runs WHERE connection_id = ? AND trigger = 'webhook'",
          [dto.id],
        ),
      ).toEqual([]);
    },
  );
});

describe('POST /hooks/connections/:id', () => {
  it('answers 202 for a valid signature, 401 for an invalid one, with problem+json errors', async () => {
    const { dto, secret } = await pushConn();
    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const url = `/hooks/connections/${dto.id}`;
    const good = await signedRequest(secret, event('evt-http'));
    const res = await app.request(url, good, kit.env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(kit.seams.jobs).toHaveLength(1);

    const bad = await signedRequest('whsec_nopenopenope0000', event('evt-http-2'));
    const denied = await app.request(url, bad, kit.env);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('content-type')).toContain('application/problem+json');
    expect(await denied.text()).not.toContain(secret);

    const unknown = await app.request(
      '/hooks/connections/nope',
      await signedRequest(secret, event('evt-http-3')),
      kit.env,
    );
    expect(unknown.status).toBe(404);
  });

  it('needs no session or CSRF token', async () => {
    const { dto, secret } = await pushConn();
    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const res = await app.request(
      `/hooks/connections/${dto.id}`,
      await signedRequest(secret, event('evt-nosession')),
      kit.env,
    );
    expect(res.status).toBe(202);
  });
});
