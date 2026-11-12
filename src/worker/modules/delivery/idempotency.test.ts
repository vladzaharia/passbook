import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP, enqueuePassEmail } from './issuance-intent.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores, clock: kit.clock });
});

type Headers = Record<string, string>;
async function post(path: string, body: unknown, key?: string) {
  const headers: Headers = {
    ...fake.admin(),
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
  };
  await seedBundlePrincipal(kit, fake, headers);
  return app.request(
    `${ORIGIN}/api/v1${path}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    kit.env,
  );
}
const emails = (passId: string) =>
  all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [passId]);

describe('bulk email honours Idempotency-Key', () => {
  it('sends once per key, replays the first result, and refuses a different selection', async () => {
    const a = await kit.pass({ holderEmail: 'bulk-a@example.com' });
    const b = await kit.pass({ holderEmail: 'bulk-b@example.com' });
    const body = { action: 'send_email', ids: [a.id, b.id], orgId: kit.org.id };
    const first = await post('/passes/bulk', body, 'bulk-key-1');
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ done: 2 });
    const replay = await post('/passes/bulk', body, 'bulk-key-1');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(await emails(a.id)).toHaveLength(1);
    expect(await emails(b.id)).toHaveLength(1);
    const other = await post('/passes/bulk', { ...body, ids: [a.id] }, 'bulk-key-1');
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await emails(a.id)).toHaveLength(1);
  });

  it('keeps sending without a key, and releases the key when the send fails', async () => {
    const a = await kit.pass({ holderEmail: 'bulk-c@example.com' });
    const body = { action: 'send_email', ids: [a.id], orgId: kit.org.id };
    expect((await post('/passes/bulk', body)).status).toBe(200);
    expect((await post('/passes/bulk', body)).status).toBe(200);
    expect(await emails(a.id)).toHaveLength(2);
    const bad = await post('/passes/bulk', { ...body, ids: ['missing-pass'] }, 'bulk-key-2');
    expect(bad.status).toBe(404);
    const retry = await post('/passes/bulk', body, 'bulk-key-2');
    expect(retry.status).toBe(200);
  });
});

describe('bundle resend honours Idempotency-Key', () => {
  it('queues one email per key', async () => {
    const a = await kit.pass({ memberName: 'Bundle idem' });
    const created = await post('/bundles', {
      orgId: kit.org.id,
      name: 'Family',
      passIds: [a.id],
      holderEmail: 'idem@example.com',
    });
    const bundle = BundleSchema.parse(await created.json());
    const path = `/bundles/${bundle.id}/send-email`;
    expect((await post(path, {}, 'bundle-key-1')).status).toBe(202);
    expect((await post(path, {}, 'bundle-key-1')).status).toBe(202);
    expect(await emails(a.id)).toHaveLength(1);
    const reused = await post(path, { to: 'other@example.com' }, 'bundle-key-1');
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await post(path, {})).status).toBe(202);
    expect(await emails(a.id)).toHaveLength(2);
  });
});

describe('bulk email keeps its result and its key', () => {
  it('turns a capped pass into a skipped entry, stores the result and replays it', async () => {
    const a = await kit.pass({ holderEmail: 'skip-a@example.com' });
    const b = await kit.pass({ holderEmail: 'skip-b@example.com' });
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++)
      await enqueuePassEmail(jobCtxOf(kit), {
        passId: b.id,
        to: 'skip-b@example.com',
        attach: false,
        expected: b,
      });
    const body = { action: 'send_email', ids: [a.id, b.id], orgId: kit.org.id };
    const first = await post('/passes/bulk', body, 'skip-key');
    expect(first.status).toBe(200);
    const result = (await first.json()) as {
      done: number;
      skipped: { id: string; code: string }[];
    };
    expect(result.done).toBe(1);
    expect(result.skipped).toEqual([{ id: b.id, code: 'EMAIL_RATE_LIMITED' }]);
    const replay = await post('/passes/bulk', body, 'skip-key');
    expect(await replay.json()).toEqual(result);
    expect(await emails(a.id)).toHaveLength(1);
  });

  it('scopes keys per principal and reclaims an unsettled key after 15 minutes', async () => {
    const a = await kit.pass({ memberName: 'Reclaim', holderEmail: 'reclaim@example.com' });
    const created = await post('/bundles', {
      orgId: kit.org.id,
      name: 'Reclaim',
      passIds: [a.id],
      holderEmail: 'reclaim@example.com',
    });
    const bundle = BundleSchema.parse(await created.json());
    const path = `/bundles/${bundle.id}/send-email`;
    expect((await post(path, { to: 'Reclaim@Example.com' }, 'reclaim-key')).status).toBe(202);
    // The lower-cased address is the same request.
    expect((await post(path, { to: 'reclaim@example.com' }, 'reclaim-key')).status).toBe(202);
    expect(await emails(a.id)).toHaveLength(1);
    const row = await first<{ key: string }>(
      kit.env.DB,
      "SELECT key FROM idempotency_keys WHERE key LIKE 'bundle-send:%reclaim-key'",
    );
    expect(row?.key).toMatch(/^bundle-send:[^:]+:[^:]+:reclaim-key$/);
    // A first call that died before settling: the key blocks retries, then expires.
    await run(kit.env.DB, 'UPDATE idempotency_keys SET resource_id = ? WHERE key = ?', [
      'reserved',
      row?.key ?? '',
    ]);
    const blocked = await post(path, { to: 'reclaim@example.com' }, 'reclaim-key');
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    kit.clock.advance(16 * 60_000);
    expect((await post(path, { to: 'reclaim@example.com' }, 'reclaim-key')).status).toBe(202);
    expect(await emails(a.id)).toHaveLength(2);
  });
});
