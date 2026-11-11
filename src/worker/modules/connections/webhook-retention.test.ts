import { createExecutionContext } from 'cloudflare:test';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { connectors } from '../../connectors/registry.ts';
import { handleQueue } from '../../jobs/queue.ts';
import { DLQ_QUEUE } from '../../jobs/retry.ts';
import { type JobOf, JobSchema } from '../../jobs/types.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  credentialAad,
  derivedHmacKey,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError } from '../../platform/errors.ts';
import { toHex } from '../../platform/ids.ts';
import { createLogger } from '../../platform/log.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  type AppleReleaseFixture,
  approveAppleRelease,
} from '../passes/apple-release-test-fixtures.ts';
import { getDeps, setDeps } from './deps.ts';
import { dailyConnections, WEBHOOK_RETENTION_MS } from './jobs.ts';
import { sealLegacyWebhookInbox } from './legacy-inbox.ts';
import { retainedById } from './repo-webhook-retention.ts';
import { replaceKeysetForTest, startPendingTransfer } from './runtime-fixtures.ts';
import { addMembership, createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';
import { processWebhook } from './webhook-process.ts';
import { loadRetainedWebhook } from './webhook-retention.ts';
import { receiveWebhook } from './webhooks.ts';

type WebhookJob = JobOf<'connection.webhook'>;
const RetainedWebhookListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          eventRef: z.string(),
          generation: z.number().int().positive(),
          connectionMode: z.enum(['webhook', 'hybrid', 'unknown']),
          state: z.enum(['pending', 'failed', 'blocked', 'resolved', 'ignored']),
          errorCode: z.string().nullable(),
          uncertainItems: z.number().int().nonnegative(),
          receivedAt: z.number(),
          updatedAt: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
type RetainedItem = z.infer<typeof RetainedWebhookListSchema>['items'][number];

let kit: Kit;
let session: SessionFixture;
let app: OpenAPIHono<AppBindings>;
let releaseFixture: AppleReleaseFixture;
let templateVersion: string;

beforeEach(async () => {
  kit = await makeKit({ realReleases: true });
  const template = makeTemplate({ id: kit.templateId, orgId: kit.org.id });
  templateVersion = template.resolved.version;
  releaseFixture = { ctx: kit.sctx, fx: kit, registry: template.registry };
  await approveAppleRelease(releaseFixture, {
    orgId: kit.org.id,
    mode: 'live',
    templateId: kit.templateId,
    version: templateVersion,
  });
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  session = await makeSession(kit, { userId: kit.actor.id });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
}, 60_000);

async function connection(kind: 'push' | 'refs' = 'push') {
  const dto = await createDemo(kit, {
    connectorType: kind === 'push' ? 'webhook-push' : 'http-json',
    config:
      kind === 'push' ? {} : { baseUrl: 'https://api.example.com', recordPath: '/members/{ref}' },
    mode: kind === 'push' ? 'webhook' : 'hybrid',
    autoCreate: true,
    defaultTemplateId: kit.templateId,
    onMissing: 'void',
  } as never);
  if (!dto.webhookSecret) throw new Error('Expected a generated webhook secret');
  return { id: dto.id, secret: dto.webhookSecret };
}

async function connectionWithoutApproval() {
  const template = makeTemplate({ id: `blocked-${kit.ids.token(4)}`, orgId: kit.org.id });
  await persistTemplate(kit, template.resolved, { registry: template.registry });
  const dto = await createDemo(kit, {
    connectorType: 'webhook-push',
    config: {},
    mode: 'webhook',
    autoCreate: true,
    defaultTemplateId: template.resolved.id,
  } as never);
  const secret = dto.webhookSecret;
  if (!secret) throw new Error('Expected a generated webhook secret');
  return { id: dto.id, secret, template };
}

async function signed(secret: string, body: unknown): Promise<Request> {
  const text = JSON.stringify(body);
  const timestamp = Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/test', {
    method: 'POST',
    headers: {
      'x-wallet-timestamp': String(timestamp),
      'x-wallet-signature': await signWebhook(secret, timestamp, text),
    },
    body: text,
  });
}

const webhookJobs = (): WebhookJob[] =>
  kit.seams.jobs.filter((job): job is WebhookJob => job.kind === 'connection.webhook');

function onlyJob(): WebhookJob {
  const jobs = webhookJobs();
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  if (!job) throw new Error('Missing webhook job');
  return job;
}

interface FakeMessage {
  id: string;
  body: WebhookJob;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function message(job: WebhookJob, attempts = 1): FakeMessage {
  const result: FakeMessage = {
    id: 'dlq-message',
    body: job,
    attempts,
    acked: false,
    retried: null,
    ack: () => {
      result.acked = true;
    },
    retry: (options) => {
      result.retried = options ?? {};
    },
  };
  return result;
}

async function deadLetter(job: WebhookJob, env: AppEnv = kit.env, attempts = 1) {
  const dead = message(job, attempts);
  const batch = { queue: DLQ_QUEUE, messages: [dead] } as unknown as MessageBatch<unknown>;
  await handleQueue(batch, env, createExecutionContext());
  return dead;
}

const failuresPath = (id: string) => `/api/v1/connections/${id}/webhook-failures`;
const replayPath = (id: string, retentionId: string) => `${failuresPath(id)}/${retentionId}/replay`;

async function call(method: 'GET' | 'POST', path: string, headers = session.headers) {
  const response = await app.request(path, { method, headers }, kit.env);
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, text, json };
}

async function list(id: string, headers = session.headers): Promise<RetainedItem[]> {
  const response = await call('GET', failuresPath(id), headers);
  expect(response.status).toBe(200);
  return RetainedWebhookListSchema.parse(response.json).items;
}

async function retainedRow(id: string) {
  return first<{ id: string; state: string; error_code: string | null }>(
    kit.env.DB,
    'SELECT id, state, error_code FROM connection_webhook_retention WHERE id = ?',
    [id],
  );
}

interface ReleaseReplayAudit {
  connection_id: string;
  org_id: string;
  actor_type: string;
  actor_id: string;
  replay_generation: number;
  old_release_id: string | null;
  old_release_generation: number | null;
  old_release_version: string | null;
  old_block_code: string | null;
  new_release_id: string | null;
  new_release_generation: number | null;
  new_release_version: string | null;
}

function replayAudits(retentionId: string) {
  return all<ReleaseReplayAudit>(
    kit.env.DB,
    `SELECT connection_id, org_id, actor_type, actor_id, replay_generation,
            old_release_id, old_release_generation, old_release_version, old_block_code,
            new_release_id, new_release_generation, new_release_version
       FROM connection_webhook_replays WHERE retention_id = ? ORDER BY replay_generation`,
    [retentionId],
  );
}

function itemStates(retentionId: string) {
  return all<{ ordinal: number; state: string }>(
    kit.env.DB,
    'SELECT ordinal, state FROM connection_webhook_items WHERE retention_id = ? ORDER BY ordinal',
    [retentionId],
  );
}

const hex = (value: string) =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** Check textual and binary columns: JSON alone hides plaintext stored as a D1 blob. */
async function expectEncrypted(id: string, sensitive: string[]) {
  const sizes = await first<{ ciphertext: number; iv: number; wrapped: number }>(
    kit.env.DB,
    `SELECT length(ciphertext) AS ciphertext, length(iv) AS iv, length(wrapped_dek) AS wrapped
     FROM connection_webhook_retention WHERE id = ?`,
    [id],
  );
  expect(sizes?.ciphertext).toBeGreaterThan(0);
  expect(sizes?.iv).toBeGreaterThan(0);
  expect(sizes?.wrapped).toBeGreaterThan(0);
  const columns = await all<{ name: string }>(
    kit.env.DB,
    'PRAGMA table_info(connection_webhook_retention)',
  );
  const hexColumns = columns
    .map(({ name }, index) => `hex("${name.replaceAll('"', '""')}") AS c${index}`)
    .join(', ');
  const raw = JSON.stringify(
    await first(kit.env.DB, 'SELECT * FROM connection_webhook_retention WHERE id = ?', [id]),
  );
  const encoded = JSON.stringify(
    await first(kit.env.DB, `SELECT ${hexColumns} FROM connection_webhook_retention WHERE id = ?`, [
      id,
    ]),
  );
  const itemMetadata = JSON.stringify(
    await all(kit.env.DB, 'SELECT * FROM connection_webhook_items WHERE retention_id = ?', [id]),
  );
  for (const value of sensitive) {
    expect(raw).not.toContain(value);
    expect(raw).not.toContain(btoa(value));
    expect(itemMetadata).not.toContain(value);
    expect(itemMetadata).not.toContain(btoa(value));
    expect(encoded).not.toContain(hex(value));
    expect(encoded).not.toContain(hex(btoa(value)));
  }
}

async function failOne(id: string, secret: string, eventId: string) {
  await receiveWebhook(
    kit.sctx,
    id,
    await signed(secret, {
      id: eventId,
      records: [{ ref: `ref-${eventId}`, record: { memberName: 'Member' } }],
    }),
  );
  const job = onlyJob();
  const dead = await deadLetter(job);
  expect(dead.acked).toBe(true);
  const items = await list(id);
  expect(items).toHaveLength(1);
  expect(items[0]?.state).toBe('failed');
  const item = items[0];
  if (!item) throw new Error('Missing retained webhook');
  return { job, item };
}

describe('durable connection webhook retention', () => {
  it('keeps exact embedded records and deletions after the inbox expires, without exposing them', async () => {
    const output: string[] = [];
    kit.sctx = {
      ...kit.sctx,
      log: createLogger({}, { level: 'debug', sink: (line) => output.push(line) }),
    };
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, secret } = await connection();
      const eventId = 'private-event-id-92e3ac';
      const ref = 'private-member-ref-42cf71';
      const deletedRef = 'private-deleted-ref-b86b90';
      const record = {
        memberName: 'Private member value 2a5b38',
        details: {
          number: 49,
          note: 'Private record note 3dd194',
          tags: ['one', 'two'],
          optional: null,
        },
      };
      const pass = await linkedPass(kit, id, ref);
      const deleted = await linkedPass(kit, id, deletedRef);
      const body = {
        id: eventId,
        records: [
          { ref, record },
          { ref: deletedRef, deleted: true },
        ],
      };
      await receiveWebhook(kit.sctx, id, await signed(secret, body));
      await receiveWebhook(kit.sctx, id, await signed(secret, body));
      const jobs = webhookJobs();
      expect(
        jobs.every((job) => job.credentialKeysetCommitment === kit.credentialKeysetCommitment),
      ).toBe(true);
      expect(jobs.flatMap((job) => job.refs)).toEqual([ref, deletedRef]);
      const staged = await all<{ id: string; credential_keyset_commitment: string }>(
        kit.env.DB,
        'SELECT id, credential_keyset_commitment FROM connection_webhook_retention WHERE connection_id = ?',
        [id],
      );
      expect(staged).toHaveLength(jobs.length);
      const privateValues = [ref, deletedRef, record.memberName, record.details.note, secret];
      for (const row of staged) {
        await expectEncrypted(row.id, privateValues);
        expect(row.credential_keyset_commitment).toBe(kit.credentialKeysetCommitment);
        const stored = await retainedById(kit.env.DB, id, row.id);
        if (!stored) throw new Error('Missing staged webhook');
        expect((await decryptRetainedPayload(kit.sctx, stored)).credentialKeysetCommitment).toBe(
          kit.credentialKeysetCommitment,
        );
      }

      for (const job of jobs) {
        const dead = await deadLetter(job);
        expect(dead.acked).toBe(true);
        expect(dead.retried).toBeNull();
      }
      const response = await call('GET', failuresPath(id));
      expect(response.status).toBe(200);
      const { items } = RetainedWebhookListSchema.parse(response.json);
      expect(items).toHaveLength(jobs.length);
      for (const item of items) {
        expect(
          await first(
            kit.env.DB,
            'SELECT reference_mode FROM connection_webhook_retention WHERE id = ?',
            [item.id],
          ),
        ).toEqual({ reference_mode: 'embedded-required' });
        expect(item).toMatchObject({ generation: 1, connectionMode: 'webhook', state: 'failed' });
        expect(Object.keys(item).sort()).toEqual([
          'connectionMode',
          'errorCode',
          'eventRef',
          'generation',
          'id',
          'receivedAt',
          'state',
          'uncertainItems',
          'updatedAt',
        ]);
        expect(item.eventRef).not.toBe(eventId);
      }
      for (const value of [...privateValues, eventId]) expect(response.text).not.toContain(value);
      const disposable = await createDemo(kit);
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [disposable.id, 'expired-unretained-event', kit.clock.now()],
      );

      kit.clock.advance(WEBHOOK_RETENTION_MS + 1);
      await dailyConnections(kit.sctx);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [id]),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [
          disposable.id,
        ]),
      ).not.toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT source, state, snapshot_known FROM connection_webhook_retention WHERE connection_id = ?',
          [disposable.id],
        ),
      ).toEqual({ source: 'legacy_cleanup_unproven', state: 'failed', snapshot_known: 0 });
      for (const row of staged) {
        expect((await retainedRow(row.id))?.state).toBe('failed');
        await expectEncrypted(row.id, privateValues);
      }
      const recovered = (
        await Promise.all(jobs.map((job) => loadRetainedWebhook(kit.sctx, job)))
      ).flatMap((chunk) => chunk?.items ?? []);
      expect(recovered).toEqual([
        { ref, record, deleted: false },
        { ref: deletedRef, record: null, deleted: true },
      ]);
      // The original session is deliberately expired by the seven-day clock advance.
      session = await makeSession(kit, { userId: kit.actor.id });
      for (const item of items) {
        const replay = await call('POST', replayPath(id, item.id));
        expect(replay.status).toBe(202);
        expect(replay.json).toEqual({ ok: true });
      }
      const replayJobs = webhookJobs().slice(jobs.length);
      expect(replayJobs).toHaveLength(jobs.length);
      expect(
        replayJobs.every(
          (job) => job.credentialKeysetCommitment === kit.credentialKeysetCommitment,
        ),
      ).toBe(true);
      for (const replayJob of replayJobs) await processWebhook(kit.sctx, replayJob);
      expect(kit.seams.applied).toHaveLength(1);
      expect(kit.seams.applied[0]).toMatchObject({ passId: pass.id });
      expect(kit.seams.applied[0]?.fields).toEqual(record);
      expect(kit.seams.missing).toEqual([{ passId: deleted.id, mode: 'void' }]);
      for (const row of staged) expect((await retainedRow(row.id))?.state).toBe('resolved');
      expect(await list(id)).toEqual([]);

      const logs = [
        ...output,
        ...debug.mock.calls.map((args) => JSON.stringify(args)),
        ...info.mock.calls.map((args) => JSON.stringify(args)),
        ...warn.mock.calls.map((args) => JSON.stringify(args)),
        ...error.mock.calls.map((args) => JSON.stringify(args)),
      ].join('\n');
      expect(logs.length).toBeGreaterThan(0);
      for (const value of [...privateValues, eventId]) expect(logs).not.toContain(value);
    } finally {
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);

  it.each(['missing', 'mismatched'] as const)(
    'does not process or acknowledge a signed chunk with %s job proof',
    async (kind) => {
      const { id, secret } = await connection('refs');
      const pass = await linkedPass(kit, id, 'proof-ref');
      let fetches = 0;
      setDeps({
        fetchImpl: (async () => {
          fetches++;
          return new Response(JSON.stringify({ memberName: 'Verified' }));
        }) as typeof fetch,
      });
      await receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'signed-proof',
          refs: ['proof-ref'],
        }),
      );
      const original = onlyJob();
      const forged = { ...original };
      if (kind === 'missing') delete forged.credentialKeysetCommitment;
      else
        forged.credentialKeysetCommitment =
          kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const parentQuery =
        'SELECT state, revision, credential_keyset_commitment, hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE connection_id = ?';
      const parentBefore = await first(kit.env.DB, parentQuery, [id]);
      const itemsBefore = await all(
        kit.env.DB,
        `SELECT i.* FROM connection_webhook_items i
        JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ?`,
        [id],
      );
      const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const outboxBefore = await all(
        kit.env.DB,
        'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
        [kit.org.id],
      );

      await expect(processWebhook(kit.sctx, forged)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      const dead = await deadLetter(forged);
      expect(dead.acked).toBe(false);
      expect(dead.retried).not.toBeNull();
      expect(await first(kit.env.DB, parentQuery, [id])).toEqual(parentBefore);
      expect(
        await all(
          kit.env.DB,
          `SELECT i.* FROM connection_webhook_items i
        JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ?`,
          [id],
        ),
      ).toEqual(itemsBefore);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        passBefore,
      );
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
      ).toEqual(outboxBefore);
      expect(fetches).toBe(0);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);

      await processWebhook(kit.sctx, original);
      expect(fetches).toBe(1);
      expect(kit.seams.applied.map((input) => input.passId)).toEqual([pass.id]);
    },
    60_000,
  );

  it.each(['missing', 'mismatched'] as const)(
    'rejects an ingress envelope with %s keyset proof',
    async (kind) => {
      const { id, secret } = await connection();
      await receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'envelope-proof',
          records: [{ ref: 'private-ref', record: { memberName: 'Private' } }],
        }),
      );
      const rowId = await first<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM connection_webhook_retention WHERE connection_id = ?',
        [id],
      );
      if (!rowId) throw new Error('Missing staged webhook');
      const stored = await retainedById(kit.env.DB, id, rowId.id);
      if (!stored) throw new Error('Missing staged webhook');
      const payload: Record<string, unknown> = {
        ...(await decryptRetainedPayload(kit.sctx, stored)),
      };
      if (kind === 'missing') delete payload.credentialKeysetCommitment;
      else
        payload.credentialKeysetCommitment =
          kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const envelope = await encryptSecret(
        await loadKekRing(kit.env),
        JSON.stringify(payload),
        credentialAad(stored.id, stored.orgId, 'connection.webhook'),
      );
      await expect(decryptRetainedPayload(kit.sctx, { ...stored, envelope })).rejects.toMatchObject(
        { code: 'WEBHOOK_PAYLOAD_MISSING' },
      );
      expect((await decryptRetainedPayload(kit.sctx, stored)).credentialKeysetCommitment).toBe(
        kit.credentialKeysetCommitment,
      );
      expect(kit.seams.created).toEqual([]);
    },
    60_000,
  );

  it.each(['missing', 'different'] as const)(
    'does not adopt a %s current keyset for retained ingress or DLQ work',
    async (sentinel) => {
      const { id, secret } = await connection();
      const pass = await linkedPass(kit, id, 'keyset-ref');
      await receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'stale-keyset',
          records: [{ ref: 'keyset-ref', record: { memberName: 'Private' } }],
        }),
      );
      const job = onlyJob();
      const parentQuery =
        'SELECT state, revision, credential_keyset_commitment, hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE connection_id = ?';
      const parentBefore = await first(kit.env.DB, parentQuery, [id]);
      const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      await replaceKeysetForTest(kit.sctx, sentinel === 'missing' ? null : other);
      try {
        await expect(processWebhook(kit.sctx, job)).rejects.toMatchObject({
          code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
        });
        const dead = await deadLetter(job);
        expect(dead.acked).toBe(false);
        expect(dead.retried).not.toBeNull();
        await expect(
          receiveWebhook(
            kit.sctx,
            id,
            await signed(secret, {
              id: 'new-after-keyset-loss',
              records: [{ ref: 'new-ref', record: { memberName: 'Must not stage' } }],
            }),
          ),
        ).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' });
        expect(
          await first(
            kit.env.DB,
            'SELECT 1 FROM webhook_events WHERE connection_id = ? AND event_id = ?',
            [id, 'new-after-keyset-loss'],
          ),
        ).toBeNull();
        expect(webhookJobs()).toHaveLength(1);
        expect(await first(kit.env.DB, parentQuery, [id])).toEqual(parentBefore);
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          passBefore,
        );
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.created).toEqual([]);
      } finally {
        await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
      await processWebhook(kit.sctx, job);
      expect(kit.seams.applied.map((input) => input.passId)).toEqual([pass.id]);
    },
    60_000,
  );

  it('retains bare refs after cleanup and fetches each one on explicit replay', async () => {
    const fetched: string[] = [];
    setDeps({
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return new Response(
          JSON.stringify({ memberName: 'Fetched after retry', exact: { active: true } }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const { id, secret } = await connection('refs');
    const refs = ['member-ref-alpha-3188', 'member-ref-beta-7782'];
    const passes = await Promise.all(refs.map((ref) => linkedPass(kit, id, ref)));
    await receiveWebhook(kit.sctx, id, await signed(secret, { id: 'bare-refs-event', refs }));
    const jobs = webhookJobs();
    expect(jobs.flatMap((job) => job.refs)).toEqual(refs);
    for (const job of jobs) expect((await deadLetter(job)).acked).toBe(true);
    const items = await list(id);
    expect(items).toHaveLength(jobs.length);
    for (const item of items) await expectEncrypted(item.id, refs);
    for (const item of items) {
      expect(
        await first(
          kit.env.DB,
          'SELECT reference_mode FROM connection_webhook_retention WHERE id = ?',
          [item.id],
        ),
      ).toEqual({ reference_mode: 'refs-only' });
    }
    kit.clock.advance(WEBHOOK_RETENTION_MS + 1);
    await dailyConnections(kit.sctx);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [id]),
    ).not.toBeNull();
    const recovered = (
      await Promise.all(jobs.map((job) => loadRetainedWebhook(kit.sctx, job)))
    ).flatMap((chunk) => chunk?.items ?? []);
    expect(recovered).toEqual(refs.map((ref) => ({ ref, record: null, deleted: false })));
    session = await makeSession(kit, { userId: kit.actor.id });
    for (const item of items)
      expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    const replayJobs = webhookJobs().slice(jobs.length);
    expect(replayJobs).toHaveLength(jobs.length);
    for (const replayJob of replayJobs) await processWebhook(kit.sctx, replayJob);
    expect(fetched.sort()).toEqual(
      refs.map((ref) => `https://api.example.com/members/${ref}`).sort(),
    );
    expect(kit.seams.applied.map((input) => input.passId).sort()).toEqual(
      passes.map((pass) => pass.id).sort(),
    );
    for (const input of kit.seams.applied) {
      expect(input.fields).toEqual({ memberName: 'Fetched after retry', exact: { active: true } });
    }
    for (const item of items) expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it('requires the stored tenant, manage capability, Live mode and CSRF for replay', async () => {
    const { id, secret } = await connection();
    const { item } = await failOne(id, secret, 'authorization');
    const before = await retainedRow(item.id);
    const otherOrg = await makeOrg(kit);
    const outsider = await makeUser(kit);
    await addMembership(kit, outsider.id, ['integration_admin'], otherOrg.id);
    const foreignSession = await makeSession(kit, { userId: outsider.id });
    expect(
      (await call('GET', `${failuresPath(id)}?orgId=${otherOrg.id}`, foreignSession.headers))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          `${replayPath(id, item.id)}?orgId=${otherOrg.id}`,
          foreignSession.headers,
        )
      ).status,
    ).toBe(404);
    const foreign = await createDemo(kit, {
      orgId: otherOrg.id,
      connectorType: 'webhook-push',
      config: {},
      mode: 'webhook',
    } as never);
    expect(await list(foreign.id, foreignSession.headers)).toEqual([]);
    expect(
      (await call('POST', replayPath(foreign.id, item.id), foreignSession.headers)).status,
    ).toBe(404);

    const reader = await makeUser(kit);
    await addMembership(kit, reader.id, ['read_only']);
    const readSession = await makeSession(kit, { userId: reader.id });
    expect(await list(id, readSession.headers)).toEqual([item]);
    expect((await call('POST', replayPath(id, item.id), readSession.headers)).status).toBe(403);
    const testHeaders = { ...session.headers, 'x-passbook-mode': 'test' };
    expect((await call('GET', failuresPath(id), testHeaders)).status).toBe(404);
    expect((await call('POST', replayPath(id, item.id), testHeaders)).status).toBe(404);
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = session.headers;
    expect((await call('POST', replayPath(id, item.id), withoutCsrf)).status).toBe(403);
    expect(await retainedRow(item.id)).toEqual(before);
    expect(webhookJobs()).toHaveLength(1);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
  }, 60_000);

  it('enforces API-key scope and tenant isolation for failure listings and explicit replay', async () => {
    const { id, secret } = await connection();
    const { item } = await failOne(id, secret, 'key-replay');
    const reader = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    const writer = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const other = await makeOrg(kit);
    const foreign = await makeApiKey(kit, {
      orgId: other.id,
      scopes: ['connections:read', 'connections:write'],
    });
    const before = await retainedRow(item.id);

    expect(await list(id, reader.headers)).toEqual([item]);
    expect((await call('POST', replayPath(id, item.id), reader.headers)).status).toBe(403);
    expect((await call('GET', failuresPath(id), writer.headers)).status).toBe(403);
    // Another organization's key cannot tell that the connection exists.
    expect((await call('GET', failuresPath(id), foreign.headers)).status).toBe(404);
    expect((await call('POST', replayPath(id, item.id), foreign.headers)).status).toBe(404);
    expect(await retainedRow(item.id)).toEqual(before);
    expect(await replayAudits(item.id)).toEqual([]);
    expect(webhookJobs()).toHaveLength(1);

    const replay = await call('POST', replayPath(id, item.id), writer.headers);
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ ok: true });
    expect(await replayAudits(item.id)).toEqual([
      expect.objectContaining({
        connection_id: id,
        org_id: kit.org.id,
        actor_type: 'api_key',
        actor_id: writer.id,
      }),
    ]);
    const queued = webhookJobs()[1];
    if (!queued) throw new Error('Missing replay job');
    await processWebhook(kit.sctx, queued);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['ref-key-replay']);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it.each(['generation', 'mode', 'disabled', 'org-moved', 'org-suspended'] as const)(
    'ACKs stale DLQ work after a %s change and preserves its encrypted terminal outcome',
    async (change) => {
      const { id, secret } = await connection();
      const pass = await linkedPass(kit, id, 'stale-ref');
      await receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'stale-dead-letter',
          records: [{ ref: 'stale-ref', record: { memberName: 'Private stale record' } }],
        }),
      );
      const job = onlyJob();
      const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const before = await first<{ id: string; ciphertext: string }>(
        kit.env.DB,
        'SELECT id, hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE connection_id = ?',
        [id],
      );
      if (!before) throw new Error('Missing staged webhook');
      if (change === 'generation') {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          id,
        ]);
      } else if (change === 'mode') {
        await run(kit.env.DB, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [id]);
      } else if (change === 'disabled') {
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [id]);
      } else if (change === 'org-moved') {
        const other = await makeOrg(kit);
        await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [other.id, id]);
      } else {
        await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      }

      for (const attempts of [1, 8]) {
        const dead = await deadLetter(job, kit.env, attempts);
        expect(dead.acked).toBe(true);
        expect(dead.retried).toBeNull();
      }
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code, hex(ciphertext) AS ciphertext FROM connection_webhook_retention WHERE id = ?',
          [before.id],
        ),
      ).toEqual({
        state: 'ignored',
        error_code: 'WEBHOOK_STALE_CONTEXT',
        ciphertext: before.ciphertext,
      });
      if (change !== 'org-moved' && change !== 'org-suspended') {
        expect(await list(id)).toEqual([
          expect.objectContaining({
            id: before.id,
            state: 'ignored',
            errorCode: 'WEBHOOK_STALE_CONTEXT',
          }),
        ]);
        const denied = await call('POST', replayPath(id, before.id));
        expect(denied.status).toBe(409);
        expect(denied.json).toMatchObject({ code: 'WEBHOOK_ALREADY_FINISHED' });
        expect(await replayAudits(before.id)).toEqual([]);
      }
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        passBefore,
      );
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
    },
    60_000,
  );

  it('ACKs a forged foreign-org DLQ message without changing the legitimate retained work', async () => {
    const { id, secret } = await connection();
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'foreign-dlq',
        records: [{ ref: 'owned-ref', record: { memberName: 'Owned' } }],
      }),
    );
    const job = onlyJob();
    const before = await first(
      kit.env.DB,
      `SELECT id, org_id, generation, state, error_code, revision, hex(ciphertext) AS ciphertext
       FROM connection_webhook_retention WHERE connection_id = ?`,
      [id],
    );
    const other = await makeOrg(kit);
    const forged = await deadLetter({ ...job, orgId: other.id });
    expect(forged.acked).toBe(true);
    expect(forged.retried).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT id, org_id, generation, state, error_code, revision, hex(ciphertext) AS ciphertext
       FROM connection_webhook_retention WHERE connection_id = ?`,
        [id],
      ),
    ).toEqual(before);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);

    const legitimate = await deadLetter(job);
    expect(legitimate.acked).toBe(true);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ?',
        [id],
      ),
    ).toEqual({ state: 'failed', error_code: 'WEBHOOK_DEAD_LETTER' });
  }, 60_000);

  it('refuses replay after the captured connection generation changes', async () => {
    const { id, secret } = await connection();
    const { item } = await failOne(id, secret, 'stale-generation');
    await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [id]);
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_STALE_CONTEXT' });
    expect(webhookJobs()).toHaveLength(1);
    expect((await retainedRow(item.id))?.state).toBe('failed');
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it('refuses replay when the connection mode changes independently of its generation', async () => {
    const { id, secret } = await connection('refs');
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, { id: 'stale-mode', refs: ['mode-ref'] }),
    );
    expect((await deadLetter(onlyJob())).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing retained event');
    await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [id]);
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_STALE_CONTEXT' });
    expect(webhookJobs()).toHaveLength(1);
    expect((await retainedRow(item.id))?.state).toBe('failed');
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it('refuses replay if the connector reference semantics change after receipt', async () => {
    const { id, secret } = await connection('refs');
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, { id: 'reference-mode', refs: ['ref-mode'] }),
    );
    const original = onlyJob();
    expect((await deadLetter(original)).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing retained event');
    expect(
      await first(
        kit.env.DB,
        'SELECT reference_mode FROM connection_webhook_retention WHERE id = ?',
        [item.id],
      ),
    ).toEqual({ reference_mode: 'refs-only' });
    const before = await retainedRow(item.id);
    const originalGet = connectors.get.bind(connectors);
    const get = vi.spyOn(connectors, 'get').mockImplementation((type) => {
      const definition = originalGet(type);
      return type === 'http-json' && definition
        ? { ...definition, webhookReferenceMode: 'embedded-required' as const }
        : definition;
    });
    try {
      const denied = await call('POST', replayPath(id, item.id));
      expect(denied.status).toBe(409);
      expect(denied.json).toMatchObject({ code: 'WEBHOOK_REFERENCE_MODE_CHANGED' });
      expect(webhookJobs()).toHaveLength(1);
      expect(await retainedRow(item.id)).toEqual(before);
      expect(await replayAudits(item.id)).toEqual([]);
    } finally {
      get.mockRestore();
    }
  }, 60_000);

  it('does not replay against a superseding approved release, even for the same template version', async () => {
    const { id, secret } = await connection();
    const { job, item } = await failOne(id, secret, 'stale-release');
    expect((await loadRetainedWebhook(kit.sctx, job))?.release).toMatchObject({ kind: 'approved' });
    await approveAppleRelease(releaseFixture, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: kit.templateId,
      version: templateVersion,
    });
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(webhookJobs()).toHaveLength(1);
    expect(await replayAudits(item.id)).toEqual([]);
    expect((await retainedRow(item.id))?.state).toBe('failed');
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it('keeps an unapproved webhook blocked until an operator explicitly replays after approval', async () => {
    const { id, secret, template } = await connectionWithoutApproval();
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'approval-required',
        records: [{ ref: 'blocked-ref', record: { memberName: 'Blocked member' } }],
      }),
    );
    await processWebhook(kit.sctx, onlyJob());
    const [item] = await list(id);
    if (!item) throw new Error('Missing blocked event');
    expect(item.state).toBe('blocked');
    const before = await call('POST', replayPath(id, item.id));
    expect(before.status).toBe(409);
    expect(before.json).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(await replayAudits(item.id)).toEqual([]);
    expect(kit.seams.created).toEqual([]);

    await approveAppleRelease(
      { ctx: kit.sctx, fx: kit, registry: template.registry },
      {
        orgId: kit.org.id,
        mode: 'live',
        templateId: template.resolved.id,
        version: template.resolved.version,
      },
    );
    const priorJobs = webhookJobs().length;
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    expect(await replayAudits(item.id)).toEqual([
      expect.objectContaining({
        connection_id: id,
        org_id: kit.org.id,
        actor_type: 'user',
        actor_id: kit.actor.id,
        replay_generation: 1,
        old_release_id: null,
        old_release_generation: null,
        old_release_version: null,
        old_block_code: 'TEMPLATE_RELEASE_REQUIRED',
        new_release_id: expect.any(String),
        new_release_generation: expect.any(Number),
        new_release_version: template.resolved.version,
      }),
    ]);
    const replayJob = webhookJobs()[priorJobs];
    if (!replayJob) throw new Error('Missing replay job');
    await processWebhook(kit.sctx, replayJob);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['blocked-ref']);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it('rolls back the replay reservation and item reset when its audit insert fails', async () => {
    const { id, secret, template } = await connectionWithoutApproval();
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'audit-rollback',
        records: [{ ref: 'audit-ref', record: { memberName: 'Audit' } }],
      }),
    );
    await processWebhook(kit.sctx, onlyJob());
    const [item] = await list(id);
    if (!item) throw new Error('Missing blocked chunk');
    expect(item.state).toBe('blocked');
    await approveAppleRelease(
      { ctx: kit.sctx, fx: kit, registry: template.registry },
      {
        orgId: kit.org.id,
        mode: 'live',
        templateId: template.resolved.id,
        version: template.resolved.version,
      },
    );
    const parentBefore = await first(
      kit.env.DB,
      'SELECT state, error_code, release_snapshot, revision, replay_generation, last_replay_id FROM connection_webhook_retention WHERE id = ?',
      [item.id],
    );
    const itemsBefore = await all(
      kit.env.DB,
      'SELECT ordinal, state, release_snapshot, token, error_code, prior_unknown FROM connection_webhook_items WHERE retention_id = ? ORDER BY ordinal',
      [item.id],
    );
    await run(
      kit.env.DB,
      `CREATE TRIGGER reject_webhook_replay_audit
      BEFORE INSERT ON connection_webhook_replays BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    try {
      const denied = await call('POST', replayPath(id, item.id));
      expect(denied.status).toBeGreaterThanOrEqual(500);
      expect(webhookJobs()).toHaveLength(1);
      expect(await replayAudits(item.id)).toEqual([]);
      expect(
        await first(
          kit.env.DB,
          'SELECT state, error_code, release_snapshot, revision, replay_generation, last_replay_id FROM connection_webhook_retention WHERE id = ?',
          [item.id],
        ),
      ).toEqual(parentBefore);
      expect(
        await all(
          kit.env.DB,
          'SELECT ordinal, state, release_snapshot, token, error_code, prior_unknown FROM connection_webhook_items WHERE retention_id = ? ORDER BY ordinal',
          [item.id],
        ),
      ).toEqual(itemsBefore);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER reject_webhook_replay_audit');
    }
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    expect(await replayAudits(item.id)).toHaveLength(1);
    expect(webhookJobs()).toHaveLength(2);
  }, 60_000);

  it.each(['same', 'missing', 'different'] as const)(
    'fences replay enqueue-failure bookkeeping when the singleton is %s',
    async (sentinel) => {
      const { id, secret } = await connection();
      const { job: original, item } = await failOne(id, secret, 'replay-keyset-race');
      type ParentSnapshot = {
        state: string;
        error_code: string | null;
        release_snapshot: string;
        revision: number;
        replay_generation: number;
        last_replay_id: string | null;
        credential_keyset_commitment: string;
      };
      const query = `SELECT state, error_code, release_snapshot, revision, replay_generation, last_replay_id,
        credential_keyset_commitment FROM connection_webhook_retention WHERE id = ?`;
      const before = await first<ParentSnapshot>(kit.env.DB, query, [item.id]);
      if (!before) throw new Error('Missing retained work');
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]);
      const reservations: ParentSnapshot[] = [];
      const attempted: WebhookJob[] = [];
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      setDeps({
        enqueueJob: async (_ctx, queued) => {
          if (queued.kind !== 'connection.webhook') throw new Error('Unexpected queue job');
          attempted.push(queued);
          const reserved = await first<ParentSnapshot>(kit.env.DB, query, [item.id]);
          if (!reserved) throw new Error('Missing replay reservation');
          reservations.push(reserved);
          if (sentinel !== 'same')
            await replaceKeysetForTest(kit.sctx, sentinel === 'missing' ? null : other);
          throw new Error('simulated replay enqueue failure');
        },
      });
      try {
        const response = await call('POST', replayPath(id, item.id));
        expect(response.status).toBe(503);
        expect(response.json).toMatchObject({ code: 'WEBHOOK_ENQUEUE_FAILED' });
        expect(attempted).toHaveLength(1);
        expect(attempted[0]?.credentialKeysetCommitment).toBe(original.credentialKeysetCommitment);
        const reserved = reservations[0];
        if (!reserved) throw new Error('Missing captured replay reservation');
        expect(reserved).toMatchObject({
          state: 'pending',
          error_code: null,
          revision: before.revision + 1,
          replay_generation: 1,
          last_replay_id: expect.any(String),
          credential_keyset_commitment: kit.credentialKeysetCommitment,
        });
        expect(await first(kit.env.DB, query, [item.id])).toEqual(
          sentinel === 'same'
            ? {
                ...reserved,
                state: 'failed',
                error_code: 'WEBHOOK_ENQUEUE_FAILED',
                revision: reserved.revision + 1,
              }
            : reserved,
        );
        expect(await itemStates(item.id)).toEqual([{ ordinal: 0, state: 'pending' }]);
        expect(await replayAudits(item.id)).toHaveLength(1);
        expect(webhookJobs()).toHaveLength(1);
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.created).toEqual([]);
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
        ).toEqual(outbox);
      } finally {
        if (sentinel !== 'same')
          await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
    },
    60_000,
  );

  it('replays only the blocked new item after an existing pass in the same chunk succeeded', async () => {
    const { id, secret, template } = await connectionWithoutApproval();
    const existing = await linkedPass(kit, id, 'already-applied');
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'mixed-blocked',
        records: [
          { ref: 'already-applied', record: { memberName: 'Updated exactly once' } },
          { ref: 'not-yet-created', record: { memberName: 'New after approval' } },
        ],
      }),
    );
    const original = onlyJob();
    await processWebhook(kit.sctx, original);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: existing.id,
      fields: { memberName: 'Updated exactly once' },
    });
    expect(kit.seams.created).toEqual([]);
    const [item] = await list(id);
    if (!item) throw new Error('Missing blocked mixed chunk');
    expect(item).toMatchObject({ state: 'blocked', errorCode: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(await itemStates(item.id)).toEqual([
      { ordinal: 0, state: 'success' },
      { ordinal: 1, state: 'blocked' },
    ]);

    await approveAppleRelease(
      { ctx: kit.sctx, fx: kit, registry: template.registry },
      {
        orgId: kit.org.id,
        mode: 'live',
        templateId: template.resolved.id,
        version: template.resolved.version,
      },
    );
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    const replayJob = webhookJobs()[1];
    if (!replayJob) throw new Error('Missing replay job');
    expect(replayJob.refs).toEqual(original.refs);
    expect(await replayAudits(item.id)).toEqual([
      expect.objectContaining({
        connection_id: id,
        org_id: kit.org.id,
        actor_type: 'user',
        actor_id: kit.actor.id,
        replay_generation: 1,
        old_block_code: 'TEMPLATE_RELEASE_REQUIRED',
        new_release_id: expect.any(String),
        new_release_version: template.resolved.version,
      }),
    ]);
    await processWebhook(kit.sctx, replayJob);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['not-yet-created']);
    expect(await itemStates(item.id)).toEqual([
      { ordinal: 0, state: 'success' },
      { ordinal: 1, state: 'success' },
    ]);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it('audits old and new approved releases when an effect-free blocked item is rebound', async () => {
    const { id, secret } = await connection();
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'release-rebind',
        records: [{ ref: 'rebind-ref', record: { memberName: 'Approved later' } }],
      }),
    );
    const original = onlyJob();
    const old = (await loadRetainedWebhook(kit.sctx, original))?.release;
    if (old?.kind !== 'approved') throw new Error('Missing original approved release');
    await approveAppleRelease(releaseFixture, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: kit.templateId,
      version: templateVersion,
    });
    await processWebhook(kit.sctx, original);
    const [item] = await list(id);
    if (!item) throw new Error('Missing release-blocked chunk');
    expect(item).toMatchObject({ state: 'blocked', errorCode: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(kit.seams.created).toEqual([]);
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    const audits = await replayAudits(item.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      connection_id: id,
      org_id: kit.org.id,
      actor_type: 'user',
      actor_id: kit.actor.id,
      replay_generation: 1,
      old_release_id: old.id,
      old_release_generation: old.generation,
      old_release_version: old.version,
      old_block_code: 'TEMPLATE_RELEASE_CONFLICT',
      new_release_id: expect.any(String),
      new_release_generation: expect.any(Number),
      new_release_version: templateVersion,
    });
    expect(audits[0]?.new_release_id).not.toBe(old.id);
    expect(audits[0]?.new_release_generation).toBeGreaterThan(old.generation);
    const replayJob = webhookJobs()[1];
    if (!replayJob) throw new Error('Missing replay job');
    await processWebhook(kit.sctx, replayJob);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['rebind-ref']);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it('refuses release rebind when a started item may have committed before a crash', async () => {
    const { id, secret, template } = await connectionWithoutApproval();
    const pass = await linkedPass(kit, id, 'uncertain-ref');
    const unrelated = await linkedPass(kit, id, 'unrelated-ref');
    let attempts = 0;
    setDeps({
      applyConnectionRecord: async (_ctx, input) => {
        attempts++;
        const claim = await first<{
          state: string;
          claim_kind: string;
          claim_pass_id: string;
          claim_snapshot: string;
        }>(
          kit.env.DB,
          `SELECT i.state, i.claim_kind, i.claim_pass_id, i.claim_snapshot
            FROM connection_webhook_items i JOIN connection_webhook_retention r ON r.id = i.retention_id
            WHERE r.connection_id = ? AND r.event_id = ?`,
          [id, 'uncertain-effect'],
        );
        expect(claim).toMatchObject({
          state: 'started',
          claim_kind: 'existing',
          claim_pass_id: pass.id,
        });
        if (!claim) throw new Error('Missing started claim');
        expect(JSON.parse(claim.claim_snapshot)).toMatchObject({
          passId: pass.id,
          identityId: input.identityId,
          credentialGeneration: input.credentialGeneration,
          lifecycleGeneration: input.lifecycleGeneration,
          transferPending: false,
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
        });
        await expect(startPendingTransfer(kit.sctx, pass.id)).rejects.toThrow();
        await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
          JSON.stringify(input.fields),
          input.passId,
        ]);
        throw new Error('simulated crash after an uncertain pass write');
      },
    });
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'uncertain-effect',
        records: [{ ref: 'uncertain-ref', record: { memberName: 'Possibly committed' } }],
      }),
    );
    const original = onlyJob();
    await expect(processWebhook(kit.sctx, original)).rejects.toThrow();
    expect(attempts).toBe(1);
    expect((await deadLetter(original)).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing uncertain chunk');
    expect(await itemStates(item.id)).toEqual([{ ordinal: 0, state: 'uncertain' }]);
    const claimed = await first<{ state: string; claim_pass_id: string; claim_snapshot: string }>(
      kit.env.DB,
      'SELECT state, claim_pass_id, claim_snapshot FROM connection_webhook_items WHERE retention_id = ?',
      [item.id],
    );
    expect(claimed).toMatchObject({ state: 'uncertain', claim_pass_id: pass.id });
    expect(JSON.parse(claimed?.claim_snapshot ?? 'null')).toMatchObject({
      passId: pass.id,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
    });
    await expect(startPendingTransfer(kit.sctx, pass.id)).rejects.toThrow();
    await startPendingTransfer(kit.sctx, unrelated.id);
    expect(
      await first(kit.env.DB, 'SELECT state FROM pass_credential_transfers WHERE pass_id = ?', [
        unrelated.id,
      ]),
    ).toEqual({ state: 'pending' });
    const before = await first(
      kit.env.DB,
      'SELECT state, release_snapshot FROM connection_webhook_retention WHERE id = ?',
      [item.id],
    );
    await approveAppleRelease(
      { ctx: kit.sctx, fx: kit, registry: template.registry },
      {
        orgId: kit.org.id,
        mode: 'live',
        templateId: template.resolved.id,
        version: template.resolved.version,
      },
    );
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_EFFECT_UNCERTAIN' });
    expect(webhookJobs()).toHaveLength(1);
    expect(attempts).toBe(1);
    expect(await replayAudits(item.id)).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, release_snapshot FROM connection_webhook_retention WHERE id = ?',
        [item.id],
      ),
    ).toEqual(before);
    const persisted = await first<{ personalization: string }>(
      kit.env.DB,
      'SELECT personalization FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(JSON.parse(persisted?.personalization ?? '{}')).toEqual({
      memberName: 'Possibly committed',
    });
  }, 60_000);

  it('replays a safe pending item while leaving an uncertain sibling for manual review', async () => {
    const { id, secret } = await connection();
    const pass = await linkedPass(kit, id, 'uncertain-sibling');
    let attempts = 0;
    setDeps({
      applyConnectionRecord: async (_ctx, input) => {
        attempts++;
        await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
          JSON.stringify(input.fields),
          input.passId,
        ]);
        throw new Error('simulated crash after the first item');
      },
    });
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'uncertain-with-pending',
        records: [
          { ref: 'uncertain-sibling', record: { memberName: 'Possibly applied' } },
          { ref: 'safe-pending', record: { memberName: 'Not yet applied' } },
        ],
      }),
    );
    const original = onlyJob();
    await expect(processWebhook(kit.sctx, original)).rejects.toThrow();
    expect(attempts).toBe(1);
    expect((await deadLetter(original)).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing uncertain mixed chunk');
    expect(await itemStates(item.id)).toEqual([
      { ordinal: 0, state: 'uncertain' },
      { ordinal: 1, state: 'pending' },
    ]);
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    const replayJob = webhookJobs()[1];
    if (!replayJob) throw new Error('Missing replay job');
    expect(replayJob.refs).toEqual(original.refs);
    await processWebhook(kit.sctx, replayJob);
    expect(attempts).toBe(1);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['safe-pending']);
    expect(await itemStates(item.id)).toEqual([
      { ordinal: 0, state: 'uncertain' },
      { ordinal: 1, state: 'success' },
    ]);
    expect((await retainedRow(item.id))?.state).toBe('failed');
    const stored = await first<{ personalization: string }>(
      kit.env.DB,
      'SELECT personalization FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(JSON.parse(stored?.personalization ?? '{}')).toEqual({ memberName: 'Possibly applied' });
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_EFFECT_UNCERTAIN' });
    expect(webhookJobs()).toHaveLength(2);
  }, 60_000);

  it('does not rebind a retried claim to a replacement pass for the same reference', async () => {
    const { id, secret } = await connection('refs');
    const originalPass = await linkedPass(kit, id, 'original-private-ref');
    let fetches = 0;
    setDeps({
      fetchImpl: (async () => {
        fetches++;
        return new Response('temporarily unavailable', { status: 503 });
      }) as typeof fetch,
    });
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'original-pass-retry',
        refs: ['original-private-ref'],
      }),
    );
    const job = onlyJob();
    await expect(processWebhook(kit.sctx, job)).rejects.toMatchObject({ code: 'WEBHOOK_UPSTREAM' });
    const query = `SELECT i.state, i.claim_kind, i.claim_pass_id, i.claim_snapshot
      FROM connection_webhook_items i JOIN connection_webhook_retention r ON r.id = i.retention_id
      WHERE r.connection_id = ? AND r.event_id = ?`;
    const before = await first<{
      state: string;
      claim_kind: string;
      claim_pass_id: string;
      claim_snapshot: string;
    }>(kit.env.DB, query, [id, 'original-pass-retry']);
    if (!before) throw new Error('Missing original claim');
    expect(before).toMatchObject({
      state: 'pending',
      claim_kind: 'existing',
      claim_pass_id: originalPass.id,
    });
    expect(JSON.parse(before.claim_snapshot)).toMatchObject({
      passId: originalPass.id,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
    });
    expect(before.claim_snapshot).not.toContain('original-private-ref');
    await run(
      kit.env.DB,
      'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = ?',
      [originalPass.id],
    );
    const replacement = await linkedPass(kit, id, 'original-private-ref');
    const originalRow = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [
      originalPass.id,
    ]);
    const replacementRow = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [
      replacement.id,
    ]);

    await processWebhook(kit.sctx, job);
    expect(fetches).toBe(1);
    expect(await first(kit.env.DB, query, [id, 'original-pass-retry'])).toEqual({
      ...before,
      state: 'uncertain',
    });
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [originalPass.id])).toEqual(
      originalRow,
    );
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [replacement.id])).toEqual(
      replacementRow,
    );
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    await expect(startPendingTransfer(kit.sctx, originalPass.id)).rejects.toThrow();
  }, 60_000);

  it('keeps the original new-pass reservation when a competing pass is linked during the fetch', async () => {
    const { id, secret } = await connection('refs');
    let reservedId: string | null = null;
    let competingId: string | null = null;
    setDeps({
      fetchImpl: (async () => {
        const claim = await first<{
          state: string;
          claim_kind: string;
          claim_pass_id: string;
          claim_snapshot: string;
        }>(
          kit.env.DB,
          `SELECT i.state, i.claim_kind, i.claim_pass_id, i.claim_snapshot
            FROM connection_webhook_items i JOIN connection_webhook_retention r ON r.id = i.retention_id
            WHERE r.connection_id = ? AND r.event_id = ?`,
          [id, 'reserved-race'],
        );
        if (!claim) throw new Error('Missing new-pass claim');
        expect(claim).toMatchObject({ state: 'started', claim_kind: 'new' });
        reservedId = claim.claim_pass_id;
        expect(JSON.parse(claim.claim_snapshot)).toMatchObject({
          kind: 'new',
          passId: reservedId,
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
        });
        const competing = await linkedPass(kit, id, 'reserved-ref');
        competingId = competing.id;
        expect(competingId).not.toBe(reservedId);
        return new Response(JSON.stringify({ memberName: 'Must not create or overwrite' }));
      }) as typeof fetch,
    });
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, { id: 'reserved-race', refs: ['reserved-ref'] }),
    );
    await processWebhook(kit.sctx, onlyJob());
    expect(reservedId).toBeTruthy();
    expect(competingId).toBeTruthy();
    const claim = await first<{ state: string; claim_pass_id: string; claim_snapshot: string }>(
      kit.env.DB,
      `SELECT i.state, i.claim_pass_id, i.claim_snapshot FROM connection_webhook_items i
        JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ?`,
      [id],
    );
    expect(claim).toMatchObject({ state: 'uncertain', claim_pass_id: reservedId });
    expect(JSON.parse(claim?.claim_snapshot ?? 'null')).toMatchObject({ passId: reservedId });
    expect(kit.seams.createAttempts).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [reservedId])).toBeNull();
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [competingId])).toEqual({
      id: competingId,
    });
    const [item] = await list(id);
    if (!item) throw new Error('Missing uncertain reservation');
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_EFFECT_UNCERTAIN' });
  }, 60_000);

  it('retains but never rebinds a legacy multi-ref dead letter with unknown original effects', async () => {
    const { id } = await connection('refs');
    const eventId = 'legacy-uncertain-event';
    const refs = ['legacy-private-a-188d', 'legacy-private-b-77ae'];
    const value = 'legacy-private-record-4dfa';
    await run(
      kit.env.DB,
      'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
      [id, eventId, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
      [id, eventId, refs[0], JSON.stringify({ memberName: value }), kit.clock.now()],
    );
    const legacy = JobSchema.parse({
      kind: 'connection.webhook',
      connectionId: id,
      orgId: kit.org.id,
      generation: 1,
      eventId,
      refs,
    });
    if (legacy.kind !== 'connection.webhook') throw new Error('Invalid legacy job');
    expect(legacy.credentialKeysetCommitment).toBeUndefined();
    expect((await deadLetter(legacy)).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing legacy dead letter');
    expect(item.state).toBe('failed');
    await expectEncrypted(item.id, [...refs, value]);
    const loaded = await loadRetainedWebhook(kit.sctx, legacy);
    expect(loaded?.credentialKeysetCommitment).toBeNull();
    expect(loaded?.items).toEqual([
      { ref: refs[0], record: { memberName: value }, deleted: false },
      { ref: refs[1], record: null, deleted: false },
    ]);
    // Simulate an envelope written before keyset proofs existed; absence is not today's key.
    const retained = await retainedById(kit.env.DB, id, item.id);
    if (!retained) throw new Error('Missing legacy envelope');
    const oldPayload: Record<string, unknown> = {
      ...(await decryptRetainedPayload(kit.sctx, retained)),
    };
    delete oldPayload.credentialKeysetCommitment;
    const envelope = await encryptSecret(
      await loadKekRing(kit.env),
      JSON.stringify(oldPayload),
      credentialAad(retained.id, retained.orgId, 'connection.webhook'),
    );
    await run(
      kit.env.DB,
      'UPDATE connection_webhook_retention SET kek_version = ?, iv = ?, wrapped_dek = ?, ciphertext = ? WHERE id = ?',
      [envelope.kekVersion, envelope.iv, envelope.wrappedDek, envelope.ciphertext, item.id],
    );
    const oldStored = await retainedById(kit.env.DB, id, item.id);
    if (!oldStored) throw new Error('Missing old legacy envelope');
    expect(
      (await decryptRetainedPayload(kit.sctx, oldStored)).credentialKeysetCommitment,
    ).toBeUndefined();
    expect((await loadRetainedWebhook(kit.sctx, legacy))?.credentialKeysetCommitment).toBeNull();
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
      kit.org.id,
    ]);
    await processWebhook(kit.sctx, legacy);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.createAttempts).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
    ).toEqual(outbox);
    const denied = await call('POST', replayPath(id, item.id));
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ code: 'WEBHOOK_SNAPSHOT_UNAVAILABLE' });
    expect(webhookJobs()).toEqual([]);
    expect(await replayAudits(item.id)).toEqual([]);
    expect((await retainedRow(item.id))?.state).toBe('failed');
  }, 60_000);

  it('does not infer a bare ref or ACK an embedded legacy event whose source is incomplete', async () => {
    const { id } = await connection();
    const eventId = 'legacy-incomplete-event';
    const present = 'legacy-present-ref-f26b';
    const missing = 'legacy-missing-ref-b67a';
    const value = 'legacy-available-value-c38e';
    await run(
      kit.env.DB,
      'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
      [id, eventId, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
      [id, eventId, present, JSON.stringify({ memberName: value }), kit.clock.now()],
    );
    const legacy: WebhookJob = {
      kind: 'connection.webhook',
      connectionId: id,
      orgId: kit.org.id,
      generation: 1,
      eventId,
      refs: [present, missing],
    };
    const definition = connectors.get('webhook-push');
    if (!definition) throw new Error('Missing webhook push connector');
    const fetch = vi.spyOn(definition, 'fetchRecord').mockResolvedValue({
      status: 'ok',
      record: { memberName: 'Must not be fetched' },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(processWebhook(kit.sctx, legacy)).rejects.toMatchObject({
        code: 'WEBHOOK_PAYLOAD_MISSING',
      });
      for (const attempts of [1, 8]) {
        // The incomplete source is retained and listed first; the deterministic code is then ACKed.
        const dead = await deadLetter(legacy, kit.env, attempts);
        expect(dead.acked).toBe(true);
        expect(dead.retried).toBeNull();
      }
      const [item] = await list(id);
      if (!item) throw new Error('Missing retained incomplete legacy event');
      expect(item).toMatchObject({ state: 'failed', errorCode: 'WEBHOOK_PAYLOAD_MISSING' });
      expect(
        await first(
          kit.env.DB,
          'SELECT source, reference_mode, error_code FROM connection_webhook_retention WHERE id = ?',
          [item.id],
        ),
      ).toEqual({
        source: 'legacy',
        reference_mode: 'embedded-required',
        error_code: 'WEBHOOK_PAYLOAD_MISSING',
      });
      expect(await sealLegacyWebhookInbox(kit.sctx, id, kit.org.id, eventId)).toEqual([
        { ref: present, record: { memberName: value }, deleted: false },
      ]);
      expect(
        await all(kit.env.DB, 'SELECT 1 FROM connection_inbox WHERE connection_id = ?', [id]),
      ).toEqual([]);
      await expectEncrypted(item.id, [present, missing, value]);
      expect(fetch).not.toHaveBeenCalled();
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      const logged = error.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      for (const privateValue of [present, missing, value])
        expect(logged).not.toContain(privateValue);
    } finally {
      fetch.mockRestore();
      error.mockRestore();
    }
  }, 60_000);

  it('seals legacy inbox data and retains distinct signed duplicate bodies under keyed identities', async () => {
    const lines: string[] = [];
    kit.sctx = {
      ...kit.sctx,
      log: createLogger({}, { level: 'debug', sink: (line) => lines.push(line) }),
    };
    const { id, secret } = await connection();
    const eventId = 'legacy-duplicate-event';
    const ref = 'legacy-duplicate-private-ref-14ab';
    const oldValue = 'legacy-original-value-63de';
    const firstValue = 'legacy-redelivery-one-e882';
    const secondValue = 'legacy-redelivery-two-f36b';
    const firstBody = {
      id: eventId,
      records: [{ ref, record: { memberName: firstValue } }],
      opaque: 'private-opaque-one-a322',
    };
    const secondBody = {
      id: eventId,
      records: [{ ref, record: { memberName: secondValue } }],
      opaque: 'private-opaque-two-b436',
    };
    await run(
      kit.env.DB,
      'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
      [id, eventId, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
      [id, eventId, ref, JSON.stringify({ memberName: oldValue }), kit.clock.now()],
    );

    await receiveWebhook(kit.sctx, id, await signed(secret, firstBody));
    await receiveWebhook(kit.sctx, id, await signed(secret, firstBody));
    await receiveWebhook(kit.sctx, id, await signed(secret, secondBody));
    expect(webhookJobs()).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM connection_inbox WHERE connection_id = ?', [id]),
    ).toEqual([]);
    expect(await sealLegacyWebhookInbox(kit.sctx, id, kit.org.id, eventId)).toEqual([
      { ref, record: { memberName: oldValue }, deleted: false },
    ]);

    const sources = await all(
      kit.env.DB,
      'SELECT * FROM connection_webhook_legacy_sources WHERE connection_id = ? AND event_id = ?',
      [id, eventId],
    );
    expect(sources).toHaveLength(1);
    const sourceHex = JSON.stringify(
      await all(
        kit.env.DB,
        'SELECT hex(iv) AS iv, hex(wrapped_dek) AS wrapped, hex(ciphertext) AS ciphertext FROM connection_webhook_legacy_sources WHERE connection_id = ? AND event_id = ?',
        [id, eventId],
      ),
    );
    const privateValues = [
      ref,
      oldValue,
      firstValue,
      secondValue,
      firstBody.opaque,
      secondBody.opaque,
      secret,
    ];
    for (const privateValue of privateValues) {
      expect(JSON.stringify(sources)).not.toContain(privateValue);
      expect(sourceHex).not.toContain(hex(privateValue));
    }

    const rows = await all<{ id: string; source: string; ref_hash: string; error_code: string }>(
      kit.env.DB,
      'SELECT id, source, ref_hash, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
      [id, eventId],
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.source === 'legacy_duplicate_unproven' &&
          row.error_code === 'WEBHOOK_LEGACY_UNCERTAIN',
      ),
    ).toBe(true);
    const key = await derivedHmacKey(kit.env, 'connection.webhook.legacy-duplicate.v1');
    const hashes = await Promise.all(
      [firstBody, secondBody].map(async (body) => {
        const message = new TextEncoder().encode(
          JSON.stringify([id, eventId, btoa(JSON.stringify(body))]),
        );
        const digest = await crypto.subtle.sign('HMAC', key, message as BufferSource);
        return `legacy-duplicate:${toHex(new Uint8Array(digest))}`;
      }),
    );
    expect(rows.map((row) => row.ref_hash).sort()).toEqual(hashes.sort());
    const decoded: { rawBody: string; refs: string[]; items: unknown[] }[] = [];
    for (const row of rows) {
      await expectEncrypted(row.id, privateValues);
      const stored = await retainedById(kit.env.DB, id, row.id);
      if (!stored) throw new Error('Missing encrypted duplicate');
      expect(stored.credentialKeysetCommitment).toBe(kit.credentialKeysetCommitment);
      const payload = await decryptRetainedPayload(kit.sctx, stored);
      expect(payload.credentialKeysetCommitment).toBe(kit.credentialKeysetCommitment);
      const wrongProof =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const badEnvelope = await encryptSecret(
        await loadKekRing(kit.env),
        JSON.stringify({ ...payload, credentialKeysetCommitment: wrongProof }),
        credentialAad(stored.id, stored.orgId, 'connection.webhook'),
      );
      await expect(
        decryptRetainedPayload(kit.sctx, { ...stored, envelope: badEnvelope }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD_MISSING' });
      const oldPayload: Record<string, unknown> = { ...payload };
      delete oldPayload.credentialKeysetCommitment;
      const oldEnvelope = await encryptSecret(
        await loadKekRing(kit.env),
        JSON.stringify(oldPayload),
        credentialAad(stored.id, stored.orgId, 'connection.webhook'),
      );
      await expect(
        decryptRetainedPayload(kit.sctx, { ...stored, envelope: oldEnvelope }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD_MISSING' });
      const oldDuplicate = { ...stored, credentialKeysetCommitment: null, envelope: oldEnvelope };
      expect(
        (await decryptRetainedPayload(kit.sctx, oldDuplicate)).credentialKeysetCommitment,
      ).toBeUndefined();
      expect(oldDuplicate).toMatchObject({ state: 'failed', snapshotKnown: false });
      if (payload.rawBody === null) throw new Error('Missing original signed body');
      decoded.push({ rawBody: payload.rawBody, refs: payload.refs, items: payload.items });
    }
    const expected = [
      {
        rawBody: btoa(JSON.stringify(firstBody)),
        refs: [ref],
        items: [{ ref, record: { memberName: firstValue }, deleted: false }],
      },
      {
        rawBody: btoa(JSON.stringify(secondBody)),
        refs: [ref],
        items: [{ ref, record: { memberName: secondValue }, deleted: false }],
      },
    ];
    expect(decoded.sort((a, b) => a.rawBody.localeCompare(b.rawBody))).toEqual(
      expected.sort((a, b) => a.rawBody.localeCompare(b.rawBody)),
    );
    const response = await call('GET', failuresPath(id));
    expect(response.status).toBe(200);
    expect(RetainedWebhookListSchema.parse(response.json).items).toHaveLength(2);
    const logged = lines.join('\n');
    for (const privateValue of [...privateValues, eventId]) {
      expect(response.text).not.toContain(privateValue);
      expect(logged).not.toContain(privateValue);
    }
    for (const row of rows) {
      const denied = await call('POST', replayPath(id, row.id));
      expect(denied.status).toBe(409);
      expect(denied.json).toMatchObject({ code: 'WEBHOOK_SNAPSHOT_UNAVAILABLE' });
      expect(await replayAudits(row.id)).toEqual([]);
    }
    expect(webhookJobs()).toEqual([]);
  }, 60_000);

  it('parks repeatedly changed template content in the DLQ without exposing the upstream error', async () => {
    const lines: string[] = [];
    kit.sctx = {
      ...kit.sctx,
      log: createLogger({}, { level: 'debug', sink: (line) => lines.push(line) }),
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, secret } = await connection();
      const ref = 'content-change-ref-270d';
      const value = 'content-change-member-921a';
      const rawError = 'content-change-upstream-private-d042';
      let attempts = 0;
      setDeps({
        createPassFromConnection: async () => {
          attempts++;
          throw new ConflictError(rawError, 'TEMPLATE_CONTENT_CHANGED');
        },
      });
      await receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'content-changed',
          records: [{ ref, record: { memberName: value } }],
        }),
      );
      const job = onlyJob();
      const original = await loadRetainedWebhook(kit.sctx, job);
      expect(original?.release).toMatchObject({ kind: 'approved' });
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(processWebhook(kit.sctx, job)).rejects.toMatchObject({
          code: 'WEBHOOK_UPSTREAM',
        });
        const current = await loadRetainedWebhook(kit.sctx, job);
        expect(current?.state).toBe('pending');
        expect(current?.release).toEqual(original?.release);
      }
      expect(attempts).toBe(3);
      expect((await deadLetter(job)).acked).toBe(true);
      const [item] = await list(id);
      if (!item) throw new Error('Missing dead-lettered item');
      expect(item).toMatchObject({ state: 'failed', errorCode: 'WEBHOOK_DEAD_LETTER' });
      expect((await loadRetainedWebhook(kit.sctx, job))?.release).toEqual(original?.release);
      expect(await replayAudits(item.id)).toEqual([]);
      const runs = await all<{ error_code: string | null; error_detail: string | null }>(
        kit.env.DB,
        'SELECT error_code, error_detail FROM connection_runs WHERE connection_id = ?',
        [id],
      );
      const emitted = [
        ...lines,
        ...info.mock.calls.map((args) => JSON.stringify(args)),
        ...warn.mock.calls.map((args) => JSON.stringify(args)),
        ...error.mock.calls.map((args) => JSON.stringify(args)),
        JSON.stringify(runs),
        JSON.stringify(item),
      ].join('\n');
      for (const privateValue of [ref, value, rawError, secret])
        expect(emitted).not.toContain(privateValue);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);

  it('requires explicit replay after an enqueue may have succeeded and applies its item only once', async () => {
    const { id, secret } = await connection();
    const enqueue = getDeps().enqueueJob;
    let calls = 0;
    setDeps({
      enqueueJob: async (ctx, job) => {
        await enqueue(ctx, job);
        calls += 1;
        if (calls === 1) throw new Error('queue response lost after enqueue');
      },
    });
    await expect(
      receiveWebhook(
        kit.sctx,
        id,
        await signed(secret, {
          id: 'uncertain-dispatch',
          records: [{ ref: 'ambiguous-ref', record: { memberName: 'Member' } }],
        }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' });
    const original = onlyJob();
    const [item] = await list(id);
    if (!item) throw new Error('Missing uncertain dispatch');
    expect(item).toMatchObject({ state: 'failed', errorCode: 'WEBHOOK_ENQUEUE_FAILED' });
    expect(await itemStates(item.id)).toEqual([{ ordinal: 0, state: 'pending' }]);
    await processWebhook(kit.sctx, original);
    expect(kit.seams.created).toEqual([]);
    expect(await itemStates(item.id)).toEqual([{ ordinal: 0, state: 'pending' }]);
    expect(await replayAudits(item.id)).toEqual([]);

    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    expect(await replayAudits(item.id)).toHaveLength(1);
    expect(webhookJobs()).toHaveLength(2);
    const replay = webhookJobs()[1];
    if (!replay) throw new Error('Missing replay job');
    await processWebhook(kit.sctx, original);
    await processWebhook(kit.sctx, replay);
    expect(kit.seams.created.map((input) => input.externalRef)).toEqual(['ambiguous-ref']);
    expect(await itemStates(item.id)).toEqual([{ ordinal: 0, state: 'success' }]);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
  }, 60_000);

  it('creates once on authorized replay even if the replay job is delivered twice', async () => {
    const { id, secret } = await connection();
    const created: string[] = [];
    setDeps({
      createPassFromConnection: async (_ctx, input) => {
        if (!input.reservedPassId) throw new Error('Missing durable pass reservation');
        const pass = await linkedPass(
          kit,
          input.connectionId,
          input.externalRef,
          kit.org.id,
          'live',
          undefined,
          input.reservedPassId,
        );
        created.push(input.externalRef);
        return { passId: pass.id };
      },
    });
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'create-once',
        records: [{ ref: 'first', record: { memberName: 'First' } }],
      }),
    );
    const job = onlyJob();
    expect(created).toEqual([]);
    expect((await deadLetter(job)).acked).toBe(true);
    const [item] = await list(id);
    if (!item) throw new Error('Missing failed event');
    expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    expect((await call('POST', replayPath(id, item.id))).status).toBe(409);
    expect(webhookJobs()).toHaveLength(2);
    const replayJob = webhookJobs()[1];
    if (!replayJob) throw new Error('Missing replay job');
    await processWebhook(kit.sctx, replayJob);
    await processWebhook(kit.sctx, replayJob);
    expect(created).toEqual(['first']);
    const rows = await all<{ external_ref: string; n: number }>(
      kit.env.DB,
      'SELECT external_ref, count(*) AS n FROM passes WHERE connection_id = ? GROUP BY external_ref ORDER BY external_ref',
      [id],
    );
    expect(rows).toEqual([{ external_ref: 'first', n: 1 }]);
    expect((await retainedRow(item.id))?.state).toBe('resolved');
    expect((await call('POST', replayPath(id, item.id))).status).toBe(409);
    expect(webhookJobs()).toHaveLength(2);
  }, 60_000);

  it('retries a connection DLQ message while its retention write fails and logs the final drop', async () => {
    const { id, secret } = await connection();
    const privateRef = 'private-dlq-ref-40cc81';
    const privateValue = 'private-dlq-value-85d622';
    await receiveWebhook(
      kit.sctx,
      id,
      await signed(secret, {
        id: 'dlq-storage-failure',
        records: [{ ref: privateRef, record: { memberName: privateValue } }],
      }),
    );
    const job = onlyJob();
    let intercepted = 0;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (
              /\b(?:UPDATE|INSERT|REPLACE|DELETE)\b[\s\S]*\bconnection_webhook_retention\b/i.test(
                sql,
              )
            ) {
              intercepted++;
              throw new Error(`retention database unavailable: ${privateRef} ${privateValue}`);
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const attempts of [1, 2]) {
        const dead = await deadLetter(job, { ...kit.env, DB: db }, attempts);
        expect(dead.acked).toBe(false);
        expect(dead.retried).not.toBeNull();
      }
      // The platform deletes the message after this attempt. The staged source stays retained.
      const last = await deadLetter(job, { ...kit.env, DB: db }, 3);
      expect(last.acked).toBe(true);
      const logged = error.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      expect(logged).toContain('queue.dlq_dropped');
      expect(logged).toContain('WEBHOOK_RETENTION_FAILED');
      expect(logged).not.toContain(privateRef);
      expect(logged).not.toContain(privateValue);
      expect(logged).not.toContain(secret);
    } finally {
      error.mockRestore();
    }
    expect(intercepted).toBe(3);
    const rows = await all<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM connection_webhook_retention WHERE connection_id = ?',
      [id],
    );
    expect(rows).toEqual([{ state: 'pending' }]);
  }, 60_000);

  it('retains and replays every chunk of a multi-chunk event without loss or duplication', async () => {
    const { id, secret } = await connection();
    const records = Array.from({ length: 45 }, (_, index) => ({
      ref: `chunk-ref-${String(index).padStart(2, '0')}`,
      record: { memberName: `Chunk member ${index}`, nested: { index } },
    }));
    const body = { id: 'multi-chunk-event', records };
    await receiveWebhook(kit.sctx, id, await signed(secret, body));
    await receiveWebhook(kit.sctx, id, await signed(secret, body));
    const jobs = webhookJobs();
    expect(jobs.map((job) => job.refs.length)).toEqual([20, 20, 5]);
    expect(
      jobs.every((job) => job.credentialKeysetCommitment === kit.credentialKeysetCommitment),
    ).toBe(true);
    for (const job of jobs) expect((await deadLetter(job)).acked).toBe(true);
    const failures = await list(id);
    expect(failures).toHaveLength(3);
    expect(new Set(failures.map((item) => item.id)).size).toBe(3);
    expect(failures.every((item) => item.state === 'failed')).toBe(true);
    kit.clock.advance(WEBHOOK_RETENTION_MS + 1);
    await dailyConnections(kit.sctx);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [id]),
    ).not.toBeNull();
    for (const [index, job] of jobs.entries()) {
      const retained = await loadRetainedWebhook(kit.sctx, job);
      expect(retained?.credentialKeysetCommitment).toBe(kit.credentialKeysetCommitment);
      expect(retained?.items).toEqual(
        records
          .slice(index * 20, index * 20 + 20)
          .map(({ ref, record }) => ({ ref, record, deleted: false })),
      );
    }
    // Unresolved chunks pin the dedupe record even beyond the usual retention window.
    await receiveWebhook(kit.sctx, id, await signed(secret, body));
    expect(webhookJobs()).toHaveLength(3);
    session = await makeSession(kit, { userId: kit.actor.id });
    for (const item of failures)
      expect((await call('POST', replayPath(id, item.id))).status).toBe(202);
    const replayJobs = webhookJobs().slice(3);
    expect(replayJobs).toHaveLength(3);
    expect(
      replayJobs.every((job) => job.credentialKeysetCommitment === kit.credentialKeysetCommitment),
    ).toBe(true);
    for (const job of replayJobs) await processWebhook(kit.sctx, job);
    const actual = kit.seams.created.map((input) => ({
      ref: input.externalRef,
      record: input.fields,
    }));
    expect(actual.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual(records);
    expect(new Set(actual.map((item) => item.ref)).size).toBe(records.length);
    expect(await list(id)).toEqual([]);
  }, 60_000);
});
