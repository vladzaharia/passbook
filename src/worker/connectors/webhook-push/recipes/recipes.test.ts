import { describe, expect, it } from 'vitest';
import { MAX_REPLAY_AGE_MS } from '../../lib/hmac.ts';
import { ConnectorError } from '../../types.ts';
import { RECIPE_INFOS, RECIPES, verifyRecipe } from './index.ts';
import type { Recipe, RecipeInput } from './shared.ts';

const enc = new TextEncoder();
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const CFG = { acceptTestEvents: false };

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

/** A delivery signed the way the sender signs it. */
async function deliver(
  r: Recipe,
  body: string,
  secret: string,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (r.verifier === 'shopify')
    headers['x-shopify-hmac-sha256'] = btoa(String.fromCharCode(...(await mac(secret, body))));
  if (r.verifier === 'calcom') headers['x-cal-signature-256'] = hex(await mac(secret, body));
  if (r.verifier === 'stripe') {
    const t = Math.floor(NOW / 1000);
    headers['stripe-signature'] = `t=${t},v1=${hex(await mac(secret, `${t}.${body}`))}`;
  }
  return new Request('https://x.test/hook', { method: 'POST', body, headers });
}
const ctx = (secret: string) => ({
  webhookSecret: secret,
  webhookSecrets: [secret],
  now: () => NOW,
});

const order = (over: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: 'gid://shopify/Order/820982911946154508',
  name: '#1001',
  order_number: 1001,
  email: 'jon@example.com',
  current_total_price: '123.45',
  currency: 'USD',
  financial_status: 'paid',
  fulfillment_status: null,
  cancelled_at: null,
  created_at: iso(NOW - 1000),
  updated_at: iso(NOW - 1000),
  customer: { first_name: 'Jon', last_name: 'Doe', email: 'c@example.com' },
  line_items: [
    { title: 'Hat', quantity: 2 },
    { title: 'Cap', quantity: 1 },
  ],
  ...over,
});

describe('registry', () => {
  it('every recipe declares what the console needs', () => {
    expect(RECIPE_INFOS.map((r) => r.id)).toEqual([
      'shopify-orders',
      'shopify-customers',
      'stripe-subscriptions',
      'stripe-payments',
      'calcom-bookings',
      'woocommerce-orders',
      'tickettailor-tickets',
    ]);
    for (const r of Object.values(RECIPES)) {
      expect(r.holderEmailField).toMatch(/^\//);
      expect(Object.keys(r.outputFields).length).toBeGreaterThan(0);
    }
  });

  it('every body window fits the ingress bound, which stays below the 7-day dedupe retention', () => {
    expect(MAX_REPLAY_AGE_MS).toBeLessThan(7 * 24 * 3_600_000);
    for (const r of Object.values(RECIPES))
      expect(r.windowMs).toBeLessThanOrEqual(MAX_REPLAY_AGE_MS);
  });
});

describe('shopify-orders', () => {
  const r = RECIPES['shopify-orders'];
  const ref = 'gid://shopify/Order/820982911946154508';

  it('maps an order to a record keyed by the gid, with exact money', () => {
    const out = adapt(r, order(), { topic: 'orders/create' });
    expect(out.refs).toEqual([ref]);
    expect(out.records[ref]).toMatchObject({
      orderName: '#1001',
      email: 'jon@example.com',
      customerName: 'Jon Doe',
      total: '123.45',
      itemCount: 3,
      firstItem: 'Hat',
    });
    expect(out.createRefs).toEqual([ref]);
    expect(out.versions[ref]).toBe(NOW - 1000);
    expect(out.signedAt).toBe(NOW - 1000);
  });

  it('ids above 2^53 stay distinct (the ref is the gid string)', () => {
    const a = adapt(r, order({ admin_graphql_api_id: 'gid://shopify/Order/820982911946154508' }));
    const b = adapt(r, order({ admin_graphql_api_id: 'gid://shopify/Order/820982911946154509' }));
    expect(a.refs[0]).not.toBe(b.refs[0]);
  });

  it('a cancelled order may update but not create', () => {
    expect(adapt(r, order({ cancelled_at: iso(NOW) })).createRefs).toEqual([]);
  });

  it('the unsigned topic only narrows: cancelled topic on a live body does not void', () => {
    const out = adapt(r, order(), { topic: 'orders/cancelled' });
    expect(out.records[ref]?.cancelledAt).toBeNull();
  });

  it.each(['products/update', 'customers/delete', 'refunds/create', 'orders/delete'])(
    'topic %s is ignored',
    (topic) => {
      expect(adapt(r, order(), { topic }).ignored).toBe('unknown_type');
    },
  );

  it.each([
    ['not an order', { admin_graphql_api_id: 'gid://shopify/Product/1', updated_at: iso(NOW) }],
    ['no gid', { id: 1 }],
    ['no updated_at', { admin_graphql_api_id: 'gid://shopify/Order/1' }],
    ['array', []],
  ])('unrecognized: %s', (_n, body) => {
    expect(adapt(r, body).ignored).toBe('unrecognized_shape');
  });
});

describe('shopify-customers', () => {
  const r = RECIPES['shopify-customers'];
  it('maps a customer and ignores customers/delete', () => {
    const body = {
      admin_graphql_api_id: 'gid://shopify/Customer/77',
      email: 'a@example.com',
      first_name: 'A',
      last_name: 'B',
      state: 'enabled',
      updated_at: iso(NOW),
    };
    const out = adapt(r, body, { topic: 'customers/update' });
    expect(out.records['gid://shopify/Customer/77']).toMatchObject({
      name: 'A B',
      state: 'enabled',
    });
    expect(adapt(r, body, { topic: 'customers/delete' }).ignored).toBe('unknown_type');
  });
});

const stripeEv = (
  type: string,
  object: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  id: 'evt_1',
  object: 'event',
  type,
  created: Math.floor(NOW / 1000),
  livemode: true,
  data: { object },
  ...over,
});

describe('stripe-subscriptions', () => {
  const r = RECIPES['stripe-subscriptions'];
  const sub = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: 1800000000, price: { nickname: 'Gold' } }] },
    ...over,
  });

  it('maps a subscription update; it never creates', () => {
    const out = adapt(r, stripeEv('customer.subscription.updated', sub()));
    expect(out.eventId).toBe('evt_1');
    expect(out.records.sub_1).toMatchObject({
      status: 'active',
      currentPeriodEnd: 1800000000,
      plan: 'Gold',
    });
    expect(out.createRefs).toEqual([]);
    expect(out.versions.sub_1).toBe(NOW);
  });

  it('reads current_period_end from the subscription when items lack it (older API versions)', () => {
    const out = adapt(
      r,
      stripeEv(
        'customer.subscription.updated',
        sub({ items: { data: [{ price: {} }] }, current_period_end: 1700000000 }),
      ),
    );
    expect(out.records.sub_1?.currentPeriodEnd).toBe(1700000000);
  });

  it('a checkout in subscription mode creates, by subscription id', () => {
    const out = adapt(
      r,
      stripeEv('checkout.session.completed', {
        mode: 'subscription',
        subscription: 'sub_9',
        customer_details: { email: 'a@example.com', name: 'A' },
      }),
    );
    expect(out.refs).toEqual(['sub_9']);
    expect(out.createRefs).toEqual(['sub_9']);
    expect(out.records.sub_9).toMatchObject({ email: 'a@example.com', status: 'active' });
  });

  it('a payment-mode checkout and other types are ignored', () => {
    expect(adapt(r, stripeEv('checkout.session.completed', { mode: 'payment' })).ignored).toBe(
      'unknown_type',
    );
    expect(adapt(r, stripeEv('invoice.paid', {})).ignored).toBe('unknown_type');
  });

  it('thin events, test mode and bad shapes', () => {
    expect(
      adapt(r, {
        id: 'evt_t',
        object: 'event',
        type: 'v1.billing.meter.error',
        created: 1,
        related_object: { id: 'x' },
      }).ignored,
    ).toBe('thin_event');
    expect(
      adapt(r, stripeEv('customer.subscription.updated', sub(), { livemode: false })).ignored,
    ).toBe('test_mode');
    expect(
      adapt(r, stripeEv('customer.subscription.updated', sub(), { livemode: false }), {
        config: { acceptTestEvents: true },
      }).ignored,
    ).toBeUndefined();
    expect(adapt(r, { object: 'list' }).ignored).toBe('unrecognized_shape');
    expect(adapt(r, stripeEv('customer.subscription.updated', {})).ignored).toBe('no_ref');
  });
});

describe('stripe-payments', () => {
  const r = RECIPES['stripe-payments'];
  it('a paid checkout creates a ticket record keyed by the payment intent', () => {
    const out = adapt(
      r,
      stripeEv('checkout.session.completed', {
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        amount_total: 2500,
        currency: 'usd',
        customer_details: { email: 'a@example.com' },
      }),
    );
    expect(out.records.pi_1).toMatchObject({ amountTotal: 2500, currency: 'usd', refunded: false });
    expect(out.createRefs).toEqual(['pi_1']);
  });
  it('an unpaid checkout is ignored', () => {
    expect(
      adapt(
        r,
        stripeEv('checkout.session.completed', {
          mode: 'payment',
          payment_status: 'unpaid',
          payment_intent: 'pi_1',
        }),
      ).ignored,
    ).toBe('unknown_type');
  });
  it('a full refund sets refunded, a partial one does not', () => {
    expect(
      adapt(r, stripeEv('charge.refunded', { payment_intent: 'pi_1', refunded: true })).records
        .pi_1,
    ).toEqual({ refunded: true });
    expect(
      adapt(r, stripeEv('charge.refunded', { payment_intent: 'pi_1', refunded: false })).records
        .pi_1,
    ).toEqual({ refunded: false });
    expect(
      adapt(r, stripeEv('charge.refunded', { payment_intent: 'pi_1', refunded: true })).createRefs,
    ).toEqual([]);
  });
});

describe('calcom-bookings', () => {
  const r = RECIPES['calcom-bookings'];
  const booking = (
    triggerEvent: string,
    payload: Record<string, unknown> = {},
    createdAt = iso(NOW - 1000),
  ) => ({
    triggerEvent,
    createdAt,
    payload: {
      uid: 'bk_1',
      bookingId: 42,
      title: 'Intro',
      attendees: [{ name: 'A', email: 'a@example.com' }],
      organizer: { name: 'O', timeZone: 'UTC' },
      ...payload,
    },
  });

  it('a created booking creates', () => {
    const out = adapt(r, booking('BOOKING_CREATED'));
    expect(out.refs).toEqual(['bk_1']);
    expect(out.records.bk_1).toMatchObject({
      status: 'created',
      attendeeEmail: 'a@example.com',
      timeZone: 'UTC',
    });
    expect(out.createRefs).toEqual(['bk_1']);
  });

  it('a request does not create; a cancel updates only', () => {
    expect(adapt(r, booking('BOOKING_REQUESTED')).createRefs).toEqual([]);
    const c = adapt(r, booking('BOOKING_CANCELLED'));
    expect(c.records.bk_1?.status).toBe('cancelled');
    expect(c.createRefs).toEqual([]);
  });

  it('a reschedule opens the new uid and retires the old one (update only)', () => {
    const out = adapt(r, booking('BOOKING_RESCHEDULED', { uid: 'bk_2', rescheduleUid: 'bk_1' }));
    expect(out.refs).toEqual(['bk_2', 'bk_1']);
    expect(out.records.bk_2?.status).toBe('created');
    expect(out.records.bk_1).toEqual({ status: 'rescheduled' });
    expect(out.createRefs).toEqual(['bk_2']);
  });

  it('flat meeting events and custom templates are unrecognized', () => {
    expect(
      adapt(r, { triggerEvent: 'MEETING_STARTED', createdAt: iso(NOW), title: 'x' }).ignored,
    ).toBe('unrecognized_shape');
    expect(adapt(r, { custom: 'template' }).ignored).toBe('unrecognized_shape');
    expect(adapt(r, booking('BOOKING_NO_SHOW_UPDATED')).ignored).toBe('unknown_type');
  });
});

describe('verifyRecipe', () => {
  const SECRET = 'shpss_demo_secret';
  const shopify = RECIPES['shopify-orders'];

  it('Shopify: the event id is the body digest, so a different X-Shopify-Webhook-Id changes nothing', async () => {
    const body = JSON.stringify(order());
    const a = await verifyRecipe(
      shopify,
      ctx(SECRET),
      await deliver(shopify, body, SECRET, {
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'one',
      }),
      CFG,
    );
    const b = await verifyRecipe(
      shopify,
      ctx(SECRET),
      await deliver(shopify, body, SECRET, {
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'two',
      }),
      CFG,
    );
    expect(a.eventId).toMatch(/^shopify:[0-9a-f]{64}$/);
    expect(a.eventId).toBe(b.eventId);
    expect(a.signedAt).toBe(NOW - 1000);
  });

  it('Shopify: a changed body is a different event', async () => {
    const a = await verifyRecipe(
      shopify,
      ctx(SECRET),
      await deliver(shopify, JSON.stringify(order()), SECRET),
      CFG,
    );
    const b = await verifyRecipe(
      shopify,
      ctx(SECRET),
      await deliver(shopify, JSON.stringify(order({ name: '#1002' })), SECRET),
      CFG,
    );
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('Shopify: a captured body replayed after its window is acknowledged as stale, never applied', async () => {
    const body = JSON.stringify(order({ updated_at: iso(NOW - 49 * 3_600_000) }));
    expect(
      await verifyRecipe(shopify, ctx(SECRET), await deliver(shopify, body, SECRET), CFG),
    ).toMatchObject({ ignored: 'stale', refs: [] });
  });

  it('Shopify: a future-dated body is refused, so the sender retries', async () => {
    const body = JSON.stringify(order({ updated_at: iso(NOW + 10 * 60_000) }));
    await expect(
      verifyRecipe(shopify, ctx(SECRET), await deliver(shopify, body, SECRET), CFG),
    ).rejects.toMatchObject({ code: 'AUTH', detail: 'expired' });
  });

  it('Shopify: a wrong secret is AUTH', async () => {
    await expect(
      verifyRecipe(
        shopify,
        ctx('another-secret-value'),
        await deliver(shopify, JSON.stringify(order()), SECRET),
        CFG,
      ),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('Shopify: an ignored topic is accepted without refs', async () => {
    const out = await verifyRecipe(
      shopify,
      ctx(SECRET),
      await deliver(shopify, JSON.stringify(order()), SECRET, {
        'x-shopify-topic': 'products/update',
      }),
      CFG,
    );
    expect(out).toMatchObject({ ignored: 'unknown_type', refs: [] });
  });

  it('Stripe: the event id is the signed event id; signedAt is the signed header time', async () => {
    const stripe = RECIPES['stripe-subscriptions'];
    const body = JSON.stringify(
      stripeEv('customer.subscription.updated', { id: 'sub_1', status: 'active' }),
    );
    const out = await verifyRecipe(
      stripe,
      ctx('whsec_test_secret'),
      await deliver(stripe, body, 'whsec_test_secret'),
      CFG,
    );
    expect(out.eventId).toBe('evt_1');
    expect(out.signedAt).toBe(Math.floor(NOW / 1000) * 1000);
    expect(out.versions).toEqual({ sub_1: NOW });
  });

  it('Cal.com: a PING trigger is a ping, whatever else the body lacks', () => {
    expect(adapt(RECIPES['calcom-bookings'], { triggerEvent: 'PING', payload: {} }).ignored).toBe(
      'ping',
    );
  });

  it('Cal.com: a body older than an hour is acknowledged as stale; a fresh one verifies with a digest id', async () => {
    const cal = RECIPES['calcom-bookings'];
    const mk = (at: number) =>
      JSON.stringify({
        triggerEvent: 'BOOKING_CREATED',
        createdAt: iso(at),
        payload: { uid: 'bk_1' },
      });
    expect(
      await verifyRecipe(
        cal,
        ctx('cal_test_secret_01'),
        await deliver(cal, mk(NOW - 2 * 3_600_000), 'cal_test_secret_01'),
        CFG,
      ),
    ).toMatchObject({ ignored: 'stale', refs: [] });
    const ok = await verifyRecipe(
      cal,
      ctx('cal_test_secret_01'),
      await deliver(cal, mk(NOW - 60_000), 'cal_test_secret_01'),
      CFG,
    );
    expect(ok.eventId).toMatch(/^calcom:[0-9a-f]{64}$/);
  });

  it('invalid JSON with a valid MAC is a bad payload, not bad auth', async () => {
    await expect(
      verifyRecipe(shopify, ctx(SECRET), await deliver(shopify, '{nope', SECRET), CFG),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});
