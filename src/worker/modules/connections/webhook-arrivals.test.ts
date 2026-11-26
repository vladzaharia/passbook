import { beforeEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { all, first, run } from '../../platform/db.ts';
import { ARRIVAL_RETENTION_MS, dailyConnections } from './jobs.ts';
import { ARRIVALS_KEPT, REJECTS_KEPT, writeArrival } from './repo-webhook-arrivals.ts';
import { getDetail } from './service.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';
import { connectionArrivals } from './webhook-arrivals.ts';
import { receiveWebhook } from './webhooks.ts';

const enc = new TextEncoder();
const MINUTE = 60_000;
let kit: Kit;
let secret = '';

beforeEach(async () => {
  kit = await makeKit();
  secret = `whsec_${crypto.randomUUID()}`;
});

async function mac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

const wooConn = (over: Record<string, unknown> = {}) =>
  createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe: 'woocommerce-orders' },
    mode: 'webhook',
    webhookSecret: secret,
    ...over,
  } as never);
const customConn = () =>
  createDemo(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' } as never);
const stripeConn = () =>
  createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe: 'stripe-payments' },
    mode: 'webhook',
    webhookSecret: secret,
  } as never);

const order = (modified: number) => ({
  id: 727,
  number: '727',
  status: 'processing',
  date_created_gmt: gmt(modified - 1000),
  date_modified_gmt: gmt(modified),
  billing: { email: 'ana@example.com', first_name: 'Ana', last_name: 'Pop' },
  line_items: [{ id: 1, name: 'Ticket', sku: 'GA', quantity: 1 }],
});

async function wooReq(
  body: string,
  over: { key?: string; topic?: string | null; sig?: boolean; type?: string } = {},
): Promise<Request> {
  const headers: Record<string, string> = { 'content-type': over.type ?? 'application/json' };
  if (over.sig !== false) {
    headers['x-wc-webhook-signature'] = b64(await mac(over.key ?? secret, body));
  }
  if (over.topic !== null) headers['x-wc-webhook-topic'] = over.topic ?? 'order.created';
  return new Request('https://wallet.test/hooks/connections/x', { method: 'POST', body, headers });
}

async function stripeReq(event: object, livemode = true): Promise<Request> {
  const body = JSON.stringify({ livemode, ...event });
  const t = Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${hex(await mac(secret, `${t}.${body}`))}` },
  });
}

async function customReq(key: string, body: string, ageSec = 0, type = 'application/json') {
  const ts = Math.floor(kit.clock.now() / 1000) - ageSec;
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: {
      'content-type': type,
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(key, ts, body),
    },
  });
}

const send = (id: string, req: Request) => receiveWebhook(kit.sctx, id, req);
const rows = (id: string, since = 0) => connectionArrivals(kit.sctx, id, { since, limit: 50 });
const lastRow = async (id: string) => (await rows(id))[0];

describe('arrival ledger: every reason has an ingress test', () => {
  it('signature_missing, signature_mismatch and the unchanged 401', async () => {
    const { id } = await wooConn();
    await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toMatchObject({
      status: 401,
      code: 'WEBHOOK_SIGNATURE',
    });
    expect(await lastRow(id)).toMatchObject({
      outcome: 'rejected',
      reason: 'signature_missing',
      topic: null,
    });
    await expect(send(id, await wooReq('{}', { key: 'wrong' }))).rejects.toMatchObject({
      status: 401,
    });
    expect((await rows(id)).map((r) => r.reason).sort()).toEqual([
      'signature_mismatch',
      'signature_missing',
    ]);
  });

  it('a malformed signature header is a mismatch, not a missing one', async () => {
    const { id } = await wooConn();
    const req = await wooReq('{}', { sig: false });
    req.headers.set('x-wc-webhook-signature', '!!!');
    await expect(send(id, req)).rejects.toMatchObject({ status: 401 });
    expect(await lastRow(id)).toMatchObject({ reason: 'signature_mismatch' });
  });

  it('signature_expired: a custom delivery signed over 5 minutes ago', async () => {
    const { id, webhookSecret } = await customConn();
    await expect(send(id, await customReq(webhookSecret ?? '', '{}', 600))).rejects.toMatchObject({
      status: 401,
    });
    expect(await lastRow(id)).toMatchObject({ outcome: 'rejected', reason: 'signature_expired' });
  });

  it('payload: signed but not the JSON the connection expects; too_large: over the cap', async () => {
    const { id, webhookSecret } = await customConn();
    await expect(
      send(id, await customReq(webhookSecret ?? '', 'nope', 0, 'text/xml')),
    ).rejects.toMatchObject({
      status: 400,
      code: 'WEBHOOK_PAYLOAD',
    });
    expect(await lastRow(id)).toMatchObject({
      outcome: 'rejected',
      reason: 'payload',
      contentClass: 'xml',
    });
    const big = await customReq(webhookSecret ?? '', 'x'.repeat(300 * 1024));
    await expect(send(id, big)).rejects.toMatchObject({ status: 400 });
    expect((await rows(id)).map((r) => r.reason).sort()).toEqual(['payload', 'too_large']);
  });

  it('no_secret: a provider-pasted connection before the secret is saved', async () => {
    const { id } = await wooConn();
    await run(kit.env.DB, 'UPDATE connections SET webhook_credential_id = NULL WHERE id = ?', [id]);
    await expect(send(id, await wooReq('{}'))).rejects.toMatchObject({ status: 401 });
    expect(await lastRow(id)).toMatchObject({ outcome: 'rejected', reason: 'no_secret' });
  });

  it('ping: a signed form body; accepted with a 202 and nothing queued', async () => {
    const { id } = await wooConn();
    await send(
      id,
      await wooReq('webhook_id=5', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    expect(await lastRow(id)).toMatchObject({
      outcome: 'ignored',
      reason: 'ping',
      contentClass: 'form',
    });
    expect(kit.seams.jobs).toEqual([]);
  });

  it('unknown_type keeps the topic only when it is the recipe\'s own, else "other"', async () => {
    const { id } = await wooConn();
    await send(id, await wooReq('{}', { topic: 'order.deleted' }));
    expect(await lastRow(id)).toMatchObject({ reason: 'unknown_type', topic: 'other' });
  });

  it('unrecognized_shape and no_ref', async () => {
    const { id } = await wooConn();
    await send(id, await wooReq('{"id":"x"}'));
    expect(await lastRow(id)).toMatchObject({
      reason: 'unrecognized_shape',
      topic: 'order.created',
    });
    const lines = await wooConn({
      webhookSecret: `${secret}-2`,
      config: { recipe: 'woocommerce-orders', passPer: 'line_item' },
    });
    const empty = { ...order(kit.clock.now() - 1000), line_items: [] };
    await send(lines.id, await wooReq(JSON.stringify(empty), { key: `${secret}-2` }));
    expect(await lastRow(lines.id)).toMatchObject({ reason: 'no_ref' });
  });

  it('thin_event and test_mode', async () => {
    const { id } = await stripeConn();
    const base = {
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(kit.clock.now() / 1000),
    };
    await send(id, await stripeReq({ ...base, data: {} }));
    expect(await lastRow(id)).toMatchObject({ outcome: 'ignored', reason: 'thin_event' });
    await send(
      id,
      await stripeReq(
        { ...base, id: 'evt_2', data: { object: { id: 'cs_1', object: 'checkout.session' } } },
        false,
      ),
    );
    expect((await rows(id)).map((r) => r.reason).sort()).toEqual(['test_mode', 'thin_event']);
  });

  it('stale: a signed body time outside the window is acknowledged, not applied or queued', async () => {
    const { id } = await wooConn();
    const old = kit.clock.now() - 72 * 3_600_000;
    await send(id, await wooReq(JSON.stringify(order(old))));
    expect(await lastRow(id)).toMatchObject({ outcome: 'ignored', reason: 'stale' });
    expect(kit.seams.jobs).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 AS n FROM connection_webhook_retention WHERE connection_id = ?',
        [id],
      ),
    ).toBeNull();
  });

  it('accepted, then duplicate; the accepted row links its retained event and keeps no body', async () => {
    const { id } = await wooConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const body = JSON.stringify(order(kit.clock.now() - 1000));
    await send(id, await wooReq(body));
    kit.clock.advance(1000);
    await send(id, await wooReq(body));
    const [dup, accepted] = await rows(id);
    expect(accepted).toMatchObject({ outcome: 'accepted', topic: 'order.created', count: 1 });
    expect(accepted?.eventRef).toMatch(/^woocommerce:[0-9a-f]{64}$/);
    expect(dup).toMatchObject({ outcome: 'duplicate', count: 1 });
    const stored = await first<{ retention_id: string | null }>(
      kit.env.DB,
      "SELECT retention_id FROM connection_webhook_arrivals WHERE outcome = 'accepted'",
    );
    expect(stored?.retention_id).toBeTruthy();
    const dump = JSON.stringify(
      await all(kit.env.DB, 'SELECT * FROM connection_webhook_arrivals WHERE connection_id = ?', [
        id,
      ]),
    );
    expect(dump).not.toMatch(/ana@example|Ana|Pop|727/);
  });

  it('signed with the previous secret is flagged on the accepted row', async () => {
    const { id } = await wooConn();
    // The flag is the verifier's usedPreviousSecret; the writer passes it through.
    await writeArrival(kit.env.DB, {
      id: kit.ids.id(),
      orgId: kit.org.id,
      connectionId: id,
      now: kit.clock.now(),
      outcome: 'accepted',
      reason: null,
      topic: null,
      contentClass: 'json',
      eventId: 'e1',
      usedPrevious: true,
      coalesceKey: null,
    });
    expect(await lastRow(id)).toMatchObject({ usedPrevious: true });
  });
});

describe('arrival ledger: abuse bounds', () => {
  it('rejects coalesce per reason and minute with a count; a new minute is a new row', async () => {
    const { id } = await wooConn();
    for (let i = 0; i < 30; i++)
      await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toBeTruthy();
    expect(await rows(id)).toHaveLength(1);
    expect((await lastRow(id))?.count).toBe(30);
    kit.clock.advance(MINUTE);
    await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toBeTruthy();
    expect(await rows(id)).toHaveLength(2);
  });

  it('a stranger cannot push verified rows out: rejects are capped below the total', async () => {
    const { id } = await wooConn();
    await send(
      id,
      await wooReq('webhook_id=1', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    for (let i = 0; i < REJECTS_KEPT + 15; i++) {
      kit.clock.advance(MINUTE);
      await expect(
        send(id, await wooReq('{}', { sig: i % 2 === 0 ? false : true, key: 'wrong' })),
      ).rejects.toBeTruthy();
    }
    const all_ = await rows(id);
    const rejected = all_.filter((r) => r.outcome === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(REJECTS_KEPT);
    expect(all_.some((r) => r.reason === 'ping')).toBe(true);
  });

  it('keeps at most 50 rows per connection and always the earliest verified one', async () => {
    const { id } = await wooConn();
    await send(
      id,
      await wooReq('webhook_id=1', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    const first_ = kit.clock.now();
    for (let i = 0; i < ARRIVALS_KEPT + 10; i++) {
      kit.clock.advance(MINUTE);
      await send(
        id,
        await wooReq(JSON.stringify(order(kit.clock.now() - 1000 + i)), {
          topic: i % 2 ? 'order.updated' : 'order.created',
        }),
      );
    }
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM connection_webhook_arrivals WHERE connection_id = ?',
      [id],
    );
    expect(count?.n).toBeLessThanOrEqual(ARRIVALS_KEPT + 1);
    const earliest = await first<{ at: number }>(
      kit.env.DB,
      'SELECT MIN(received_at) AS at FROM connection_webhook_arrivals WHERE connection_id = ?',
      [id],
    );
    expect(earliest?.at).toBe(first_);
  });

  it('the daily hook purges rows older than 7 days except the earliest verified one', async () => {
    const { id } = await wooConn();
    await send(
      id,
      await wooReq('webhook_id=1', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toBeTruthy();
    kit.clock.advance(ARRIVAL_RETENTION_MS + MINUTE);
    await send(
      id,
      await wooReq('webhook_id=2', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    await dailyConnections(kit.sctx);
    const left = await all<{ outcome: string; received_at: number }>(
      kit.env.DB,
      'SELECT outcome, received_at FROM connection_webhook_arrivals WHERE connection_id = ? ORDER BY received_at',
      [id],
    );
    expect(left.map((r) => r.outcome)).toEqual(['ignored', 'ignored']);
    expect(left[0]?.received_at).toBeLessThan(kit.clock.now() - ARRIVAL_RETENTION_MS);
  });

  it('a ledger failure never fails the delivery', async () => {
    const { id } = await wooConn();
    await run(kit.env.DB, 'ALTER TABLE connection_webhook_arrivals RENAME TO arrivals_gone');
    try {
      await send(
        id,
        await wooReq('webhook_id=1', { type: 'application/x-www-form-urlencoded', topic: null }),
      );
      await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      await run(kit.env.DB, 'ALTER TABLE arrivals_gone RENAME TO connection_webhook_arrivals');
    }
  });

  it('a disabled or unknown connection records nothing', async () => {
    await expect(send('nope', await wooReq('{}', { sig: false }))).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 AS n FROM connection_webhook_arrivals WHERE connection_id = ?',
        ['nope'],
      ),
    ).toBeNull();
  });
});

describe('arrival ledger: first verified arrival and health', () => {
  it('a webhook connection is awaiting until a signed delivery arrives; a refusal does not clear it', async () => {
    const { id } = await wooConn();
    expect(await getDetail(kit.sctx, id)).toMatchObject({
      health: 'awaiting',
      firstVerifiedArrivalAt: null,
    });
    await expect(send(id, await wooReq('{}', { sig: false }))).rejects.toBeTruthy();
    expect(await getDetail(kit.sctx, id)).toMatchObject({ health: 'awaiting' });
    await send(
      id,
      await wooReq('webhook_id=1', { type: 'application/x-www-form-urlencoded', topic: null }),
    );
    expect(await getDetail(kit.sctx, id)).toMatchObject({
      health: 'unknown',
      firstVerifiedArrivalAt: kit.clock.now(),
    });
  });
});
