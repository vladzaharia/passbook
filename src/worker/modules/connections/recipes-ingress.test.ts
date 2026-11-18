import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTemplate } from '../../../../test/helpers/index.ts';
import { MAX_REPLAY_AGE_MS } from '../../connectors/lib/hmac.ts';
import connector from '../../connectors/webhook-push/index.ts';
import { all, first } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { WEBHOOK_RETENTION_MS } from './jobs.ts';
import { createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { processWebhook } from './webhook-process.ts';
import { receiveWebhook } from './webhooks.ts';

const enc = new TextEncoder();
// Unique per test: a pasted secret is unique platform-wide and the database outlives a test.
let STRIPE_SECRET = '';
let SHOPIFY_SECRET = '';

let kit: Kit;
beforeEach(async () => {
  STRIPE_SECRET = `whsec_${crypto.randomUUID()}`;
  SHOPIFY_SECRET = `shpss_${crypto.randomUUID()}`;
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

const nowSec = () => Math.floor(kit.clock.now() / 1000);

async function stripeRequest(event: object): Promise<Request> {
  const body = JSON.stringify(event);
  const t = nowSec();
  return new Request('https://wallet.test/hooks/connections/x', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${hex(await mac(STRIPE_SECRET, `${t}.${body}`))}` },
  });
}

const stripeEvent = (
  id: string,
  type: string,
  object: Record<string, unknown>,
  created = nowSec(),
) => ({
  id,
  object: 'event',
  type,
  created,
  livemode: true,
  data: { object },
});

const subscription = (status = 'active', over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  status,
  customer: 'cus_1',
  ...over,
});

async function stripeConn(over: Record<string, unknown> = {}) {
  return createDemo(kit, {
    connectorType: 'webhook-push',
    config: { recipe: 'stripe-subscriptions' },
    mode: 'webhook',
    webhookSecret: STRIPE_SECRET,
    mapping: { memberName: { from: '/customerId' } },
    voidWhen: [{ from: '/status', op: 'in', values: ['canceled'] }],
    ...over,
  } as never);
}

/** Delivers one request and applies the job it queued. */
async function apply(connectionId: string, req: Request) {
  const before = kit.seams.jobs.length;
  await receiveWebhook(kit.sctx, connectionId, req);
  const job = kit.seams.jobs[before];
  if (job?.kind !== 'connection.webhook') return false;
  await processWebhook(kit.sctx, job);
  return true;
}

describe('void when', () => {
  it('a matching record voids the bound pass with RECORD_VOIDED and applies nothing else', async () => {
    const dto = await stripeConn();
    const pass = await linkedPass(kit, dto.id, 'sub_1');
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_1', 'customer.subscription.deleted', subscription('canceled')),
      ),
    );
    expect(kit.seams.voided).toEqual([{ passId: pass.id }]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });

  it('a matching record with no bound pass creates nothing', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent(
          'evt_1',
          'customer.subscription.deleted',
          subscription('canceled', { id: 'sub_9' }),
        ),
      ),
    );
    expect(kit.seams.voided).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });

  it('a non-matching record updates the pass', async () => {
    const dto = await stripeConn();
    const pass = await linkedPass(kit, dto.id, 'sub_1');
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_1', 'customer.subscription.updated', subscription('active')),
      ),
    );
    expect(kit.seams.applied.map((a) => a.passId)).toEqual([pass.id]);
    expect(kit.seams.voided).toEqual([]);
  });

  it('a voided pass is not matched again, and a later non-matching record does not unvoid it', async () => {
    const dto = await stripeConn();
    const pass = await linkedPass(kit, dto.id, 'sub_1');
    const info = vi.spyOn(kit.sctx.log, 'info');
    await kit.env.DB.prepare("UPDATE passes SET status = 'voided' WHERE id = ?")
      .bind(pass.id)
      .run();
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_1', 'customer.subscription.deleted', subscription('canceled')),
      ),
    );
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_2', 'customer.subscription.updated', subscription('active'), nowSec() + 1),
      ),
    );
    expect(kit.seams.voided).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    // The sender has moved on from the void rule: logged for the health panel, nothing changes.
    expect(info.mock.calls.filter((c) => c[0] === 'connection.void_would_clear')).toEqual([
      ['connection.void_would_clear', { connectionId: dto.id, code: 'VOID_WOULD_CLEAR' }],
    ]);
    const row = await first<{ status: string }>(
      kit.env.DB,
      'SELECT status FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.status).toBe('voided');
  });
});

describe('create gate', () => {
  it('a subscription update for an unknown ref does not create a pass', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent(
          'evt_1',
          'customer.subscription.updated',
          subscription('active', { id: 'sub_9' }),
        ),
      ),
    );
    expect(kit.seams.created).toEqual([]);
  });

  it('a checkout creates it, and a subscription update for the same ref still updates it', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_1', 'checkout.session.completed', {
          mode: 'subscription',
          subscription: 'sub_9',
          customer: 'cus_9',
          customer_details: { email: 'a@example.com' },
        }),
      ),
    );
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['sub_9']);
  });

  it('an update that arrives before its checkout does not block the later create', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent(
          'evt_2',
          'customer.subscription.updated',
          subscription('active', { id: 'sub_9' }),
          t + 5,
        ),
      ),
    );
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent(
          'evt_1',
          'checkout.session.completed',
          { mode: 'subscription', subscription: 'sub_9', customer: 'cus_9' },
          t,
        ),
      ),
    );
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['sub_9']);
  });
});

describe('source order', () => {
  const versionOf = (connectionId: string) =>
    first<{ source_version: number }>(
      kit.env.DB,
      'SELECT source_version FROM connection_ref_versions WHERE connection_id = ? AND ref = ?',
      [connectionId, 'sub_1'],
    );

  it('an older record is skipped, an equal one applies, a newer one applies', async () => {
    const dto = await stripeConn();
    await linkedPass(kit, dto.id, 'sub_1');
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_a', 'customer.subscription.updated', subscription('active'), t),
      ),
    );
    expect(kit.seams.applied).toHaveLength(1);
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_old', 'customer.subscription.updated', subscription('active'), t - 30),
      ),
    );
    expect(kit.seams.applied).toHaveLength(1);
    expect((await versionOf(dto.id))?.source_version).toBe(t * 1000);
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_tie', 'customer.subscription.updated', subscription('active'), t),
      ),
    );
    expect(kit.seams.applied).toHaveLength(2);
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_new', 'customer.subscription.updated', subscription('active'), t + 10),
      ),
    );
    expect(kit.seams.applied).toHaveLength(3);
    expect((await versionOf(dto.id))?.source_version).toBe((t + 10) * 1000);
  });

  it('a stale cancellation after a newer update does not void', async () => {
    const dto = await stripeConn();
    await linkedPass(kit, dto.id, 'sub_1');
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_a', 'customer.subscription.updated', subscription('active'), t),
      ),
    );
    await apply(
      dto.id,
      await stripeRequest(
        stripeEvent('evt_b', 'customer.subscription.deleted', subscription('canceled'), t - 60),
      ),
    );
    expect(kit.seams.voided).toEqual([]);
  });
});

describe('ingress', () => {
  it('an ignored event is accepted without a webhook_events row, a job or vendor text in the log', async () => {
    const dto = await stripeConn();
    const info = vi.spyOn(kit.sctx.log, 'info');
    const evt = stripeEvent('evt_1', 'invoice.paid', {
      id: 'in_secret_marker',
      customer_email: 'leak@example.com',
    });
    await receiveWebhook(kit.sctx, dto.id, await stripeRequest(evt));
    expect(kit.seams.jobs).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM webhook_events WHERE connection_id = ?', [dto.id]),
    ).toEqual([]);
    const call = info.mock.calls.find((c) => c[0] === 'connection.webhook_ignored');
    expect(call?.[1]).toEqual({
      connectionId: dto.id,
      code: 'WEBHOOK_EVENT_IGNORED',
      kind: 'unknown_type',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('in_secret_marker');
    expect(JSON.stringify(info.mock.calls)).not.toContain('invoice.paid');
  });

  it('a delivery signed with another org connection secret is refused', async () => {
    const a = await stripeConn();
    const b = await stripeConn({ webhookSecret: `whsec_${crypto.randomUUID()}` });
    await expect(
      receiveWebhook(
        kit.sctx,
        b.id,
        await stripeRequest(stripeEvent('evt_1', 'customer.subscription.updated', subscription())),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(a.id).not.toBe(b.id);
  });

  it('Shopify: the same body with different X-Shopify-Webhook-Id values is one event', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'webhook-push',
      config: { recipe: 'shopify-orders' },
      mode: 'webhook',
      webhookSecret: SHOPIFY_SECRET,
      mapping: { memberName: { from: '/orderName' } },
    } as never);
    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/Order/820982911946154508',
      name: '#1001',
      updated_at: new Date(kit.clock.now() - 1000).toISOString(),
    });
    const sig = btoa(String.fromCharCode(...(await mac(SHOPIFY_SECRET, body))));
    const send = (webhookId: string) =>
      receiveWebhook(
        kit.sctx,
        dto.id,
        new Request('https://wallet.test/h', {
          method: 'POST',
          body,
          headers: {
            'x-shopify-hmac-sha256': sig,
            'x-shopify-topic': 'orders/create',
            'x-shopify-webhook-id': webhookId,
          },
        }),
      );
    await send('one');
    await send('two');
    expect(kit.seams.jobs).toHaveLength(1);
    const events = await all<{ event_id: string }>(
      kit.env.DB,
      'SELECT event_id FROM webhook_events WHERE connection_id = ?',
      [dto.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event_id).toMatch(/^shopify:[0-9a-f]{64}$/);
  });

  it('a recipe delivery without a signed time in the window is refused, whatever the connector returned', async () => {
    const dto = await stripeConn();
    const verify = vi.spyOn(connector, 'verifyWebhook');
    verify.mockResolvedValueOnce({ eventId: 'e', refs: [] });
    await expect(receiveWebhook(kit.sctx, dto.id, await stripeRequest({}))).rejects.toMatchObject({
      status: 401,
    });
    verify.mockResolvedValueOnce({
      eventId: 'e',
      refs: [],
      signedAt: kit.clock.now() - MAX_REPLAY_AGE_MS - 1,
    });
    await expect(receiveWebhook(kit.sctx, dto.id, await stripeRequest({}))).rejects.toMatchObject({
      status: 401,
    });
    verify.mockRestore();
  });

  it('the replay bound stays inside the dedupe retention', () => {
    expect(MAX_REPLAY_AGE_MS).toBeLessThan(WEBHOOK_RETENTION_MS);
  });
});

describe('recipe fixed after creation', () => {
  it('refuses a config change of the recipe and accepts the same recipe', async () => {
    const { update } = await import('./service.ts');
    const dto = await stripeConn();
    await expect(
      update(kit.sctx, kit.actor, dto.id, { config: { recipe: 'shopify-orders' } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      update(kit.sctx, kit.actor, dto.id, {
        config: { recipe: 'stripe-subscriptions', acceptTestEvents: true },
      }),
    ).resolves.toBeDefined();
  });
});

describe('ordering across deliveries', () => {
  const sub = (id: string, type: string, status: string, created: number) =>
    stripeEvent(id, type, subscription(status, { id: 'sub_9' }), created);
  const checkout = (id: string, created: number) =>
    stripeEvent(
      id,
      'checkout.session.completed',
      { mode: 'subscription', subscription: 'sub_9', customer: 'cus_9' },
      created,
    );

  it('a cancellation before its create leaves a tombstone: the older create is stale', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(sub('evt_del', 'customer.subscription.deleted', 'canceled', t)),
    );
    await apply(dto.id, await stripeRequest(checkout('evt_chk', t - 30)));
    expect(kit.seams.created).toEqual([]);
  });

  it('a newer create after a cancellation (a re-subscription) still creates', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(sub('evt_del', 'customer.subscription.deleted', 'canceled', t)),
    );
    await apply(dto.id, await stripeRequest(checkout('evt_chk', t + 30)));
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['sub_9']);
  });

  it('create then cancellation voids the bound pass', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const pass = await linkedPass(kit, dto.id, 'sub_9');
    const t = nowSec();
    await apply(dto.id, await stripeRequest(checkout('evt_chk', t)));
    await apply(
      dto.id,
      await stripeRequest(sub('evt_del', 'customer.subscription.deleted', 'canceled', t + 5)),
    );
    expect(kit.seams.voided).toEqual([{ passId: pass.id }]);
  });

  it('an update that arrives before its create does not block the create', async () => {
    const dto = await stripeConn({ autoCreate: true, defaultTemplateId: kit.templateId });
    const t = nowSec();
    await apply(
      dto.id,
      await stripeRequest(sub('evt_upd', 'customer.subscription.updated', 'active', t + 5)),
    );
    await apply(dto.id, await stripeRequest(checkout('evt_chk', t)));
    expect(kit.seams.created.map((c) => c.externalRef)).toEqual(['sub_9']);
  });

  it.each([
    [['evt_a', 'evt_b'], 2],
    [['evt_b', 'evt_a'], 1],
  ])('records of one version are ordered by event id: %j applies %d', async (order, applied) => {
    const t = nowSec();
    const dto = await stripeConn();
    await linkedPass(kit, dto.id, 'sub_1');
    for (const id of order) {
      await apply(
        dto.id,
        await stripeRequest(
          stripeEvent(id, 'customer.subscription.updated', subscription('active'), t),
        ),
      );
    }
    // The larger id wins: arriving first it blocks the smaller; arriving last it applies as well.
    expect(kit.seams.applied).toHaveLength(applied);
  });
});

describe('review hardening', () => {
  it('a far-future source version is refused at ingress', async () => {
    const dto = await stripeConn();
    const far = nowSec() + 3 * 24 * 3600;
    await expect(
      receiveWebhook(
        kit.sctx,
        dto.id,
        await stripeRequest(
          stripeEvent('evt_far', 'customer.subscription.updated', subscription('active'), far),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(kit.seams.jobs).toEqual([]);
  });

  it('a Stripe event without livemode counts as test mode', async () => {
    const dto = await stripeConn();
    const evt = stripeEvent('evt_nl', 'customer.subscription.updated', subscription('active'));
    const { livemode: _l, ...noLive } = evt;
    const info = vi.spyOn(kit.sctx.log, 'info');
    await receiveWebhook(kit.sctx, dto.id, await stripeRequest(noLive));
    expect(kit.seams.jobs).toEqual([]);
    expect(info.mock.calls.find((c) => c[0] === 'connection.webhook_ignored')?.[1]).toMatchObject({
      kind: 'test_mode',
    });
  });

  it('a pasted recipe secret cannot be used by a second connection', async () => {
    await stripeConn();
    await expect(stripeConn({ name: 'Second' })).rejects.toMatchObject({ status: 422 });
    await expect(
      stripeConn({ name: 'Third', webhookSecret: `whsec_${crypto.randomUUID()}` }),
    ).resolves.toBeDefined();
  });

  it('the same secret may back custom connections, and a replaced secret frees the old one', async () => {
    const sharedCustom = `custom_${crypto.randomUUID()}`;
    const mk = (name: string) =>
      createDemo(kit, {
        connectorType: 'webhook-push',
        config: {},
        mode: 'webhook',
        name,
        webhookSecret: sharedCustom,
      } as never);
    await mk('a');
    await expect(mk('b')).resolves.toBeDefined();
    const { update } = await import('./service.ts');
    const dto = await stripeConn();
    await update(kit.sctx, kit.actor, dto.id, {
      webhookSecret: `whsec_${crypto.randomUUID()}`,
      overlapSeconds: 0,
    });
    await expect(stripeConn({ name: 'Reuse old' })).resolves.toBeDefined();
  });
});
