import { beforeEach, describe, expect, it } from 'vitest';
import { makeTemplate } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { processWebhook } from './webhook-process.ts';
import { receiveWebhook } from './webhooks.ts';

const enc = new TextEncoder();
let WOO = '';
let TT = '';
let kit: Kit;

beforeEach(async () => {
  // A pasted secret is unique platform-wide and the database outlives a test.
  WOO = `woo-${crypto.randomUUID()}`;
  TT = `tt-${crypto.randomUUID()}`;
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
const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

const wooOrder = (over: Record<string, unknown> = {}, ageMs = 1000) => ({
  id: 727,
  number: '727',
  status: 'processing',
  currency: 'EUR',
  date_created_gmt: gmt(kit.clock.now() - 60_000),
  date_modified_gmt: gmt(kit.clock.now() - ageMs),
  total: '60.00',
  billing: { first_name: 'Ana', last_name: 'Pop', email: 'ana@example.com' },
  line_items: [
    { id: 311, name: 'Gala', sku: 'VIP', quantity: 1, total: '40.00', total_tax: '0.00' },
    { id: 312, name: 'Gala', sku: 'STD', quantity: 1, total: '20.00', total_tax: '0.00' },
  ],
  refunds: [],
  ...over,
});

async function wooRequest(order: object, secret = WOO): Promise<Request> {
  const body = JSON.stringify(order);
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: {
      'x-wc-webhook-signature': btoa(String.fromCharCode(...(await mac(secret, body)))),
      'x-wc-webhook-topic': 'order.updated',
    },
  });
}

async function ttRequest(event: object, secret = TT): Promise<Request> {
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

const ticketEvent = (id: string, event: string, status: string) => ({
  id,
  event,
  created_at: Math.floor(kit.clock.now() / 1000) - 2,
  payload: { id: 'it_1', order_id: 'or_1', status, full_name: 'Ana Pop', email: 'a@example.com' },
});

const wooConn = (over: Record<string, unknown> = {}) =>
  createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe: 'woocommerce-orders' },
    mode: 'webhook',
    webhookSecret: WOO,
    autoCreate: true,
    defaultTemplateId: kit.templateId,
    mapping: { memberName: { from: '/name' } },
    voidWhen: [
      { from: '/status', op: 'in', values: ['cancelled', 'refunded', 'failed', 'trash'] },
      { from: '/refunded', op: 'in', values: [true] },
    ],
    ...over,
  } as never);

const ttConn = (over: Record<string, unknown> = {}) =>
  createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe: 'tickettailor-tickets' },
    mode: 'webhook',
    webhookSecret: TT,
    autoCreate: true,
    defaultTemplateId: kit.templateId,
    mapping: { memberName: { from: '/name' } },
    voidWhen: [{ from: '/status', op: 'in', values: ['voided'] }],
    ...over,
  } as never);

async function apply(connectionId: string, req: Request) {
  const before = kit.seams.jobs.length;
  await receiveWebhook(kit.sctx, connectionId, req);
  const job = kit.seams.jobs[before];
  if (job?.kind !== 'connection.webhook') return false;
  await processWebhook(kit.sctx, job);
  return true;
}

describe('WooCommerce ingress', () => {
  it('a paid order creates a pass with the order id as its external ref', async () => {
    const dto = await wooConn();
    await apply(dto.id, await wooRequest(wooOrder()));
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['order:727']);
  });

  it('per line item: one pass for each line', async () => {
    const dto = await wooConn({ config: { recipe: 'woocommerce-orders', passPer: 'line_item' } });
    await apply(dto.id, await wooRequest(wooOrder()));
    expect(kit.seams.created.map((c) => c.externalRef).sort()).toEqual([
      'order:727:line:311',
      'order:727:line:312',
    ]);
  });

  it('a redelivery is one event: one row, one job', async () => {
    const dto = await wooConn();
    const body = wooOrder();
    await receiveWebhook(kit.sctx, dto.id, await wooRequest(body));
    await receiveWebhook(kit.sctx, dto.id, await wooRequest(body));
    expect(kit.seams.jobs).toHaveLength(1);
    const rows = await all<{ event_id: string }>(
      kit.env.DB,
      'SELECT event_id FROM webhook_events WHERE connection_id = ?',
      [dto.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toMatch(/^woocommerce:[0-9a-f]{64}$/);
  });

  it('a refunded order voids the bound pass', async () => {
    const dto = await wooConn();
    const pass = await linkedPass(kit, dto.id, 'order:727');
    await apply(dto.id, await wooRequest(wooOrder({ status: 'refunded' })));
    expect(kit.seams.voided).toEqual([{ passId: pass.id }]);
  });

  it('a partial refund voids only the line it matches', async () => {
    const dto = await wooConn({ config: { recipe: 'woocommerce-orders', passPer: 'line_item' } });
    const vip = await linkedPass(kit, dto.id, 'order:727:line:311');
    const std = await linkedPass(kit, dto.id, 'order:727:line:312');
    await apply(dto.id, await wooRequest(wooOrder({ refunds: [{ id: 9, total: '-20.00' }] })));
    expect(kit.seams.voided).toEqual([{ passId: std.id }]);
    expect(vip.id).not.toBe(std.id);
  });

  it('an unknown topic is acknowledged without a job', async () => {
    const dto = await wooConn();
    const req = await wooRequest(wooOrder());
    await receiveWebhook(
      kit.sctx,
      dto.id,
      new Request(req.url, {
        method: 'POST',
        body: JSON.stringify(wooOrder()),
        headers: { ...Object.fromEntries(req.headers), 'x-wc-webhook-topic': 'order.deleted' },
      }),
    );
    expect(kit.seams.jobs).toHaveLength(0);
  });

  it("another connection's secret is refused", async () => {
    const a = await wooConn();
    const b = await wooConn({ webhookSecret: `woo-${crypto.randomUUID()}` });
    await expect(
      receiveWebhook(kit.sctx, b.id, await wooRequest(wooOrder())),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('Ticket Tailor ingress', () => {
  it('an issued ticket creates a pass; a redelivery is one event', async () => {
    const dto = await ttConn();
    const ev = ticketEvent('WHE-1', 'ISSUED_TICKET.CREATED', 'valid');
    await receiveWebhook(kit.sctx, dto.id, await ttRequest(ev));
    await receiveWebhook(kit.sctx, dto.id, await ttRequest(ev));
    expect(kit.seams.jobs).toHaveLength(1);
    await processWebhook(kit.sctx, kit.seams.jobs[0] as never);
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['it_1']);
  });

  it('a voided ticket voids the bound pass', async () => {
    const dto = await ttConn();
    const pass = await linkedPass(kit, dto.id, 'it_1');
    await apply(dto.id, await ttRequest(ticketEvent('WHE-2', 'ISSUED_TICKET.UPDATED', 'voided')));
    expect(kit.seams.voided).toEqual([{ passId: pass.id }]);
  });

  it('an unknown event is acknowledged and applies nothing', async () => {
    const dto = await ttConn();
    await apply(dto.id, await ttRequest(ticketEvent('WHE-3', 'ORDER.CREATED', 'valid')));
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.voided).toEqual([]);
  });

  it("another connection's secret is refused", async () => {
    await ttConn();
    const b = await ttConn({ webhookSecret: `tt-${crypto.randomUUID()}` });
    await expect(
      receiveWebhook(
        kit.sctx,
        b.id,
        await ttRequest(ticketEvent('WHE-4', 'ISSUED_TICKET.CREATED', 'valid')),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
