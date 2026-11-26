import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../types.ts';
import { RECIPES, verifyRecipe } from './index.ts';
import type { Recipe, RecipeConfig, RecipeInput } from './shared.ts';

const enc = new TextEncoder();
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0);
const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const CFG: RecipeConfig = { acceptTestEvents: false, passPer: 'order' };
const LINES: RecipeConfig = { ...CFG, passPer: 'line_item' };

const woo = RECIPES['woocommerce-orders'];
const tt = RECIPES['tickettailor-tickets'];
const adapt = (r: Recipe, body: unknown, over: Partial<RecipeInput> = {}) =>
  r.adapt({ body, digest: 'd'.repeat(64), now: NOW, config: CFG, topic: null, ...over });

async function mac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const ctx = (secret: string) => ({
  webhookSecret: secret,
  webhookSecrets: [secret],
  now: () => NOW,
});

const wooReq = async (body: string, secret: string, topic = 'order.created') =>
  new Request('https://x.test/h', {
    method: 'POST',
    body,
    headers: {
      'x-wc-webhook-signature': btoa(String.fromCharCode(...(await mac(secret, body)))),
      'x-wc-webhook-topic': topic,
    },
  });
const ttReq = async (body: string, secret: string, t = Math.floor(NOW / 1000)) =>
  new Request('https://x.test/h', {
    method: 'POST',
    body,
    headers: {
      'tickettailor-webhook-signature': `timestamp=${t},signature=${hex(await mac(secret, `${t}${body}`))}`,
    },
  });

// Shape: https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties
const order = (over: Record<string, unknown> = {}) => ({
  id: 727,
  number: '727',
  status: 'processing',
  currency: 'EUR',
  date_created_gmt: gmt(NOW - 5000),
  date_modified_gmt: gmt(NOW - 1000),
  total: '60.00',
  billing: { first_name: 'Ana', last_name: 'Pop', email: 'ana@example.com' },
  line_items: [
    {
      id: 311,
      name: 'Gala night',
      sku: 'GALA-VIP',
      quantity: 2,
      total: '40.00',
      total_tax: '0.00',
    },
    {
      id: 312,
      name: 'Gala night',
      sku: 'GALA-STD',
      quantity: 1,
      total: '20.00',
      total_tax: '0.00',
    },
  ],
  refunds: [],
  ...over,
});

describe('woocommerce-orders adapter', () => {
  it('a paid order is one record keyed by order id; the mapping inputs are filled', () => {
    const out = adapt(woo, order(), { topic: 'order.created' });
    expect(out.refs).toEqual(['order:727']);
    expect(out.records['order:727']).toMatchObject({
      orderId: '727',
      name: 'Ana Pop',
      email: 'ana@example.com',
      eventName: 'Gala night',
      ticketType: 'GALA-VIP',
      itemCount: 3,
      refunded: false,
    });
    expect(out.createRefs).toEqual(['order:727']);
    expect(out.signedAt).toBe(NOW - 1000);
  });

  it('per line item: one ref per line, each with its own product and quantity', () => {
    const out = adapt(woo, order(), { config: LINES });
    expect(out.refs).toEqual(['order:727:line:311', 'order:727:line:312']);
    expect(out.records['order:727:line:312']).toMatchObject({
      ticketType: 'GALA-STD',
      quantity: 1,
    });
    expect(out.createRefs).toEqual(out.refs);
  });

  it.each(['pending', 'on-hold', 'failed'])('a %s order does not create', (status) => {
    expect(adapt(woo, order({ status })).createRefs).toEqual([]);
  });

  it.each(['cancelled', 'refunded'])(
    'a %s order does not create and carries the status',
    (status) => {
      const out = adapt(woo, order({ status }));
      expect(out.createRefs).toEqual([]);
      expect(out.records['order:727']?.status).toBe(status);
    },
  );

  it('a full refund (status refunded) marks every line refunded', () => {
    const out = adapt(woo, order({ status: 'refunded' }), { config: LINES });
    expect(Object.values(out.records).map((r) => r.refunded)).toEqual([true, true]);
  });

  it('refunds that add up to the total are a full refund even when the status lags', () => {
    const out = adapt(woo, order({ refunds: [{ id: 1, total: '-60.00' }] }));
    expect(out.records['order:727']?.refunded).toBe(true);
    expect(out.createRefs).toEqual([]);
  });

  it('a partial refund leaves an order pass alone', () => {
    const out = adapt(woo, order({ refunds: [{ id: 1, total: '-20.00' }] }));
    expect(out.records['order:727']?.refunded).toBe(false);
  });

  it('a partial refund matching one line voids that line only', () => {
    const out = adapt(woo, order({ refunds: [{ id: 1, total: '-20.00' }] }), { config: LINES });
    expect(out.records['order:727:line:311']?.refunded).toBe(false);
    expect(out.records['order:727:line:312']?.refunded).toBe(true);
  });

  it('a refund matching two lines is ambiguous and voids none', () => {
    const lines = [
      { id: 1, name: 'A', quantity: 1, total: '10.00' },
      { id: 2, name: 'B', quantity: 1, total: '10.00' },
      { id: 3, name: 'C', quantity: 1, total: '30.00' },
    ];
    const out = adapt(woo, order({ line_items: lines, refunds: [{ id: 1, total: '-10.00' }] }), {
      config: LINES,
    });
    expect(Object.values(out.records).map((r) => r.refunded)).toEqual([false, false, false]);
  });

  it('GMT fields without a zone are read as UTC', () => {
    expect(adapt(woo, order()).versions['order:727']).toBe(NOW - 1000);
  });

  it.each(['order.deleted', 'order.restored', 'product.created'])(
    'topic %s is ignored',
    (topic) => {
      expect(adapt(woo, order(), { topic }).ignored).toBe('unknown_type');
    },
  );

  it('the ping form body (not JSON) is a ping', () => {
    expect(adapt(woo, undefined).ignored).toBe('ping');
  });

  it.each([
    ['no id', order({ id: undefined })],
    ['no status', order({ status: undefined })],
    ['no modified time', order({ date_modified_gmt: undefined })],
    ['array', []],
  ])('unrecognized: %s', (_n, body) => {
    expect(adapt(woo, body).ignored).toBe('unrecognized_shape');
  });
});

describe('woocommerce-orders verification', () => {
  const secret = 'woo-demo-secret';
  const body = JSON.stringify(order());

  it('valid: verifies, the id is the body digest, the signed time is the body time', async () => {
    const out = await verifyRecipe(woo, ctx(secret), await wooReq(body, secret), CFG);
    expect(out.eventId).toMatch(/^woocommerce:[0-9a-f]{64}$/);
    expect(out.signedAt).toBe(NOW - 1000);
    expect(out.createRefs).toEqual(['order:727']);
  });

  it('a redelivery of the same body is the same event id; another body is not', async () => {
    const a = await verifyRecipe(woo, ctx(secret), await wooReq(body, secret), CFG);
    const b = await verifyRecipe(
      woo,
      ctx(secret),
      await wooReq(body, secret, 'order.updated'),
      CFG,
    );
    const c = await verifyRecipe(
      woo,
      ctx(secret),
      await wooReq(JSON.stringify(order({ status: 'completed' })), secret),
      CFG,
    );
    expect(a.eventId).toBe(b.eventId);
    expect(c.eventId).not.toBe(a.eventId);
  });

  it('invalid: a wrong secret, a tampered body and a missing header are AUTH', async () => {
    const wrong = await wooReq(body, 'another-secret-0123456789');
    await expect(verifyRecipe(woo, ctx(secret), wrong, CFG)).rejects.toMatchObject({
      code: 'AUTH',
    });
    const good = await wooReq(body, secret);
    const tampered = new Request('https://x.test/h', {
      method: 'POST',
      body: body.replace('Ana', 'Eve'),
      headers: good.headers,
    });
    await expect(verifyRecipe(woo, ctx(secret), tampered, CFG)).rejects.toBeInstanceOf(
      ConnectorError,
    );
    const bare = new Request('https://x.test/h', { method: 'POST', body });
    await expect(verifyRecipe(woo, ctx(secret), bare, CFG)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('replayed: a valid MAC on a body modified over 48 hours ago is acknowledged as stale, not applied', async () => {
    const old = JSON.stringify(order({ date_modified_gmt: gmt(NOW - 49 * 3_600_000) }));
    expect(await verifyRecipe(woo, ctx(secret), await wooReq(old, secret), CFG)).toMatchObject({
      ignored: 'stale',
      refs: [],
    });
  });

  it('the signed ping (form body) is accepted and ignored as a ping', async () => {
    const out = await verifyRecipe(woo, ctx(secret), await wooReq('webhook_id=5', secret), CFG);
    expect(out.ignored).toBe('ping');
    expect(out.refs).toEqual([]);
  });

  it('a previous secret is accepted and flagged', async () => {
    const req = await wooReq(body, 'old-secret-0123456789');
    const out = await verifyRecipe(
      woo,
      { ...ctx(secret), webhookSecrets: [secret, 'old-secret-0123456789'] },
      req,
      CFG,
    );
    expect(out.usedPreviousSecret).toBe(true);
  });
});

// Shape: https://developers.tickettailor.com/#webhooks and #issued-tickets
const hook = (over: Record<string, unknown> = {}, ticket: Record<string, unknown> = {}) => ({
  id: 'WHE-1',
  event: 'ISSUED_TICKET.CREATED',
  created_at: Math.floor(NOW / 1000) - 5,
  payload: {
    id: 'it_100',
    order_id: 'or_9',
    status: 'valid',
    barcode: 'AB12CD',
    email: 'ana@example.com',
    first_name: 'Ana',
    last_name: 'Pop',
    full_name: 'Ana Pop',
    description: 'Early bird',
    event_summary: { name: 'Spring gala' },
    ...ticket,
  },
  ...over,
});

describe('tickettailor-tickets adapter', () => {
  it('an issued ticket creates a pass keyed by the ticket id', () => {
    const out = adapt(tt, hook());
    expect(out.refs).toEqual(['it_100']);
    expect(out.records.it_100).toMatchObject({
      orderId: 'or_9',
      name: 'Ana Pop',
      eventName: 'Spring gala',
      ticketType: 'Early bird',
      status: 'valid',
    });
    expect(out.createRefs).toEqual(['it_100']);
    expect(out.eventId).toBe('tickettailor:WHE-1');
  });

  it('a voided ticket updates the record and never creates', () => {
    const out = adapt(tt, hook({ event: 'ISSUED_TICKET.UPDATED' }, { status: 'voided' }));
    expect(out.records.it_100?.status).toBe('voided');
    expect(out.createRefs).toEqual([]);
  });

  it('an unknown event is ignored', () => {
    expect(adapt(tt, hook({ event: 'ORDER.CREATED' })).ignored).toBe('unknown_type');
  });

  it.each([
    ['no envelope', { id: 'x' }],
    ['no payload', hook({ payload: undefined })],
    ['array', []],
  ])('unrecognized: %s', (_n, body) => {
    expect(adapt(tt, body).ignored).toBe('unrecognized_shape');
  });
});

describe('tickettailor-tickets verification', () => {
  const secret = 'tt-demo-secret';
  const body = JSON.stringify(hook());

  it('valid: the event id is the signed webhook id and the time is the header time', async () => {
    const out = await verifyRecipe(tt, ctx(secret), await ttReq(body, secret), CFG);
    expect(out.eventId).toBe('tickettailor:WHE-1');
    expect(out.signedAt).toBe(Math.floor(NOW / 1000) * 1000);
  });

  it('invalid: wrong secret, tampered body and a missing header are AUTH', async () => {
    await expect(
      verifyRecipe(tt, ctx(secret), await ttReq(body, 'another-secret-0123456789'), CFG),
    ).rejects.toMatchObject({ code: 'AUTH' });
    const good = await ttReq(body, secret);
    const tampered = new Request('https://x.test/h', {
      method: 'POST',
      body: body.replace('Ana', 'Eve'),
      headers: good.headers,
    });
    await expect(verifyRecipe(tt, ctx(secret), tampered, CFG)).rejects.toMatchObject({
      code: 'AUTH',
    });
    await expect(
      verifyRecipe(tt, ctx(secret), new Request('https://x.test/h', { method: 'POST', body }), CFG),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('stale: a valid MAC with a timestamp over 300 s old is AUTH', async () => {
    const t = Math.floor(NOW / 1000) - 301;
    await expect(
      verifyRecipe(tt, ctx(secret), await ttReq(body, secret, t), CFG),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('a signature over `timestamp.body` (a separator) is rejected', async () => {
    const t = Math.floor(NOW / 1000);
    const req = new Request('https://x.test/h', {
      method: 'POST',
      body,
      headers: {
        'tickettailor-webhook-signature': `timestamp=${t},signature=${hex(await mac(secret, `${t}.${body}`))}`,
      },
    });
    await expect(verifyRecipe(tt, ctx(secret), req, CFG)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it("a Stripe signature header is not accepted: each sender's own header only", async () => {
    const t = Math.floor(NOW / 1000);
    const req = new Request('https://x.test/h', {
      method: 'POST',
      body,
      headers: {
        'stripe-signature': `timestamp=${t},signature=${hex(await mac(secret, `${t}${body}`))}`,
      },
    });
    await expect(verifyRecipe(tt, ctx(secret), req, CFG)).rejects.toMatchObject({ code: 'AUTH' });
  });
});
