import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeTemplate } from '../../../../test/helpers/index.ts';
import { RECIPE_INFOS } from '../../connectors/webhook-push/recipes/index.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { previewArrival } from './preview-arrival.ts';
import { getConnection } from './repo.ts';
import { update } from './service.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';
import { connectionArrivals } from './webhook-arrivals.ts';
import { processWebhook } from './webhook-process.ts';
import { receiveWebhook } from './webhooks.ts';

const enc = new TextEncoder();
let kit: Kit;

beforeEach(async () => {
  kit = await makeKit();
  const template = makeTemplate({ id: kit.templateId, orgId: kit.org.id });
  const release = await approveAppleRelease(
    { ctx: kit.sctx, fx: kit, registry: template.registry },
    { orgId: kit.org.id, templateId: kit.templateId, version: template.resolved.version },
  );
  kit.seams.release = { id: release.id, generation: release.generation, version: release.version };
});

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
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const fresh = (p: string) => `${p}_${crypto.randomUUID()}`;

const conn = (recipe: string, over: Record<string, unknown> = {}) =>
  createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe },
    mode: 'webhook',
    name: `${recipe}-${crypto.randomUUID().slice(0, 4)}`,
    ...over,
  } as never);

async function stripeReq(secret: string): Promise<Request> {
  const body = JSON.stringify({ livemode: true, id: 'evt_1', type: 'x', data: { object: {} } });
  const t = Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${hex(await mac(secret, `${t}.${body}`))}` },
  });
}

async function ttReq(secret: string, event: object): Promise<Request> {
  const body = JSON.stringify(event);
  const t = Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: {
      'tickettailor-webhook-signature': `timestamp=${t},signature=${hex(await mac(secret, `${t}${body}`))}`,
    },
  });
}

describe('create then paste (Stripe)', () => {
  it('a provider-issued secret is not generated: the connection starts without one', async () => {
    const dto = await conn('stripe-payments');
    expect(dto.hasWebhookSecret).toBe(false);
    expect(dto.webhookSecret).toBeUndefined();
    await expect(
      receiveWebhook(kit.sctx, dto.id, await stripeReq('whsec_nothing')),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await connectionArrivals(kit.sctx, kit.org.id, dto.id, { since: 0, limit: 5 }))[0],
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'no_secret',
    });
  });

  it('an unrelated update does not generate one, and the paste is stored', async () => {
    const dto = await conn('stripe-payments');
    await update(kit.sctx, kit.actor, dto.id, { name: 'Renamed' });
    expect((await getConnection(kit.env.DB, dto.id))?.webhookCredentialId).toBeNull();
    const pasted = fresh('whsec');
    const after = await update(kit.sctx, kit.actor, dto.id, { webhookSecret: pasted });
    expect(after.hasWebhookSecret).toBe(true);
    // Verified now: it is no longer refused for a missing secret.
    const err = await receiveWebhook(kit.sctx, dto.id, await stripeReq(pasted)).catch(
      (e: unknown) => e,
    );
    expect(err).not.toMatchObject({ status: 401 });
  });

  it('a PassBook-issued secret is still generated (custom, Cal.com)', async () => {
    const dto = await conn('calcom-bookings');
    expect(dto.hasWebhookSecret).toBe(true);
    expect(typeof dto.webhookSecret).toBe('string');
  });
});

describe('Shopify secretScope account', () => {
  it('orders and customers share one secret in one org', async () => {
    const secret = fresh('shpss');
    await conn('shopify-orders', { webhookSecret: secret });
    await expect(conn('shopify-customers', { webhookSecret: secret })).resolves.toBeDefined();
    await expect(conn('shopify-orders', { webhookSecret: secret })).resolves.toBeDefined();
  });

  it('another org may not use it', async () => {
    const secret = fresh('shpss');
    await conn('shopify-orders', { webhookSecret: secret });
    const other = await makeOrg(kit);
    await expect(
      conn('shopify-orders', { webhookSecret: secret, orgId: other.id }),
    ).rejects.toMatchObject({ status: 422, message: 'This signing secret cannot be used.' });
  });

  it('a Shopify secret cannot back another family, and the reverse', async () => {
    const secret = fresh('shpss');
    await conn('shopify-orders', { webhookSecret: secret });
    await expect(conn('stripe-payments', { webhookSecret: secret })).rejects.toMatchObject({
      status: 422,
    });
    const s2 = fresh('whsec');
    await conn('stripe-payments', { webhookSecret: s2 });
    await expect(conn('shopify-orders', { webhookSecret: s2 })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('other recipes still refuse a reused secret', async () => {
    const s = fresh('whsec');
    await conn('stripe-payments', { webhookSecret: s });
    await expect(conn('stripe-subscriptions', { webhookSecret: s })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('WooCommerce secret origin', () => {
  it('PassBook generates the secret and the picker does not ask for a paste', async () => {
    const info = RECIPE_INFOS.find((r) => r.id === 'woocommerce-orders');
    expect(info).toMatchObject({ pasteSecret: false, secretOrigin: 'passbook' });
    const dto = await conn('woocommerce-orders');
    expect(dto.webhookSecret).toMatch(/\S{16,}/);
  });
});

describe('Ticket Tailor topic case', () => {
  it('a lowercase event is applied like an uppercase one', async () => {
    const secret = fresh('tt');
    const dto = await conn('tickettailor-tickets', {
      webhookSecret: secret,
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/name' } },
    });
    const event = {
      id: 'WHE-1',
      event: 'issued_ticket.created',
      created_at: Math.floor(kit.clock.now() / 1000) - 2,
      payload: { id: 'it_1', order_id: 'or_1', status: 'valid', full_name: 'Ana', email: 'a@e.co' },
    };
    const before = kit.seams.jobs.length;
    await receiveWebhook(kit.sctx, dto.id, await ttReq(secret, event));
    const job = kit.seams.jobs[before];
    expect(job?.kind).toBe('connection.webhook');
    if (job?.kind === 'connection.webhook') await processWebhook(kit.sctx, job);
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['it_1']);
  });
});

describe('preview from an arrival', () => {
  const order = () => ({
    id: 727,
    number: '727',
    status: 'processing',
    currency: 'EUR',
    date_created_gmt: gmt(kit.clock.now() - 60_000),
    date_modified_gmt: gmt(kit.clock.now() - 1000),
    total: '60.00',
    billing: { first_name: 'Ana', last_name: 'Pop', email: 'ana@example.com' },
    line_items: [
      { id: 311, name: 'Gala', sku: 'VIP', quantity: 1, total: '40.00', total_tax: '0.00' },
    ],
    refunds: [],
  });

  async function arrive(secret: string, id: string) {
    const body = JSON.stringify(order());
    await receiveWebhook(
      kit.sctx,
      id,
      new Request('https://wallet.test/hooks/connections/x', {
        method: 'POST',
        body,
        headers: {
          'x-wc-webhook-signature': b64(await mac(secret, body)),
          'x-wc-webhook-topic': 'order.updated',
        },
      }),
    );
    return (await connectionArrivals(kit.sctx, kit.org.id, id, { since: 0, limit: 5 }))[0];
  }

  it('shows what the kept event would make, and writes nothing', async () => {
    const secret = fresh('woo');
    const dto = await conn('woocommerce-orders', {
      webhookSecret: secret,
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/name' } },
    });
    const row = await arrive(secret, dto.id);
    expect(row?.outcome).toBe('accepted');
    const jobsBefore = kit.seams.jobs.length;
    const preview = await previewArrival(kit.sctx, dto.id, row?.id ?? '');
    expect(preview).toMatchObject({ ok: true, records: 1, counts: { create: 1, errors: 0 } });
    expect(preview.samples[0]).toMatchObject({ ref: 'order:727', action: 'create' });
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.jobs).toHaveLength(jobsBefore);
  });

  it('an arrival that is not accepted, or not this connection, is not found', async () => {
    const secret = fresh('woo');
    const a = await conn('woocommerce-orders', { webhookSecret: secret });
    const b = await conn('woocommerce-orders', { webhookSecret: fresh('woo') });
    const row = await arrive(secret, a.id);
    await expect(previewArrival(kit.sctx, b.id, row?.id ?? '')).rejects.toMatchObject({
      status: 404,
    });
    await expect(previewArrival(kit.sctx, a.id, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
