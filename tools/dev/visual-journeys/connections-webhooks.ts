// Connections and outbound webhooks: wizard, a connection's health and runs, an endpoint, its deliveries, a replay.
// The endpoint stays paused: deliveries queue, nothing is sent outside the dev server.
import type { Page } from '@playwright/test';
import type { Journey } from '../lib/journey.ts';
import { issue, type Json, page, passOf, templateByName } from './kit.ts';

const EXTERNAL_ID = 'journey-webhooks-card';
const DESCRIPTION = 'Journey webhook';

/** Picks the Demo connector and presses Next `steps` times, naming the connection on the way. */
const wizardTo = (steps: number) => async (p: Page) => {
  await p.locator('label', { hasText: 'Demo' }).first().click({ timeout: 5_000 });
  for (let i = 0; i < steps; i++) {
    if (i === 1)
      await p
        .getByLabel(/^name/i)
        .first()
        .fill('Journey sync', { timeout: 4_000 })
        .catch(() => undefined);
    await p.getByRole('button', { name: 'Next' }).click({ timeout: 5_000 });
    await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }
};

const openDelivery = async (p: Page) => {
  await p
    .getByRole('button', { name: /^(Pass )?(updated|issued|voided)/i })
    .first()
    .click();
};

export const connectionsWebhooks: Journey = {
  name: 'connections-webhooks',
  title: 'Connections and webhooks',
  org: 'northwind',
  steps: [
    { title: 'Connections', run: async () => page('org', '/admin/connections') },
    { title: 'Wizard: connector', run: async () => page('org', '/admin/connections/new') },
    ...(['configuration', 'mapping', 'lifecycle', 'review'] as const).map((name, i) => ({
      title: `Wizard: ${name}`,
      run: async () => page('org', '/admin/connections/new', { prepare: wizardTo(i + 1) }),
    })),
    {
      title: 'Connection health and runs',
      async run(env) {
        const owner = await env.api('org');
        const list = await owner.get(`/api/v1/connections?orgId=${env.orgId}`);
        const demo = list.items.find((c: Json) => c.connectorType === 'demo');
        if (!demo) return { skip: 'no demo connection; run tools/seed-demo.ts' };
        env.vars.connectionId = demo.id;
        await owner.post(`/api/v1/connections/${demo.id}/sync?orgId=${env.orgId}`);
        return page('org', `/admin/connections/${demo.id}?tab=health`);
      },
    },
    {
      title: 'Connection mapping',
      async run(env) {
        if (!env.vars.connectionId) return { skip: 'no connection' };
        return page('org', `/admin/connections/${env.vars.connectionId}?tab=mapping`);
      },
    },
    {
      title: 'New webhook endpoint',
      run: async () => page('org', '/admin/connections/webhooks/new'),
    },
    {
      title: 'Endpoint created',
      async run(env) {
        const owner = await env.api('org');
        const q = `orgId=${env.orgId}`;
        const all: Json = await owner.get(`/api/v1/webhook-endpoints?${q}`);
        let endpoint = all.items.find((e: Json) => e.description === DESCRIPTION);
        if (!endpoint) {
          const made = await owner.post(`/api/v1/webhook-endpoints?${q}`, {
            orgId: env.orgId,
            // hooks.example.com is the host the e2e server resolves without DNS (WEBHOOK_TEST_DNS).
            url: `https://hooks.example.com/journey-hook-${env.stamp}`,
            description: DESCRIPTION,
            eventTypes: ['pass.issued', 'pass.updated', 'pass.voided'],
          });
          endpoint = made.endpoint;
        }
        // Paused at once so no delivery leaves the machine.
        await owner.patch(`/api/v1/webhook-endpoints/${endpoint.id}?${q}`, { status: 'paused' });
        env.vars.endpointId = endpoint.id;
        return page('org', `/admin/connections/webhooks/${endpoint.id}?orgId=${env.orgId}`);
      },
    },
    {
      title: 'Deliveries after an update',
      async run(env) {
        const owner = await env.api('org');
        const keyed = await env.keyFor(env.orgId);
        const found: Json = await keyed.get(
          `/api/v1/passes?orgId=${env.orgId}&externalId=${EXTERNAL_ID}`,
        );
        let pass = found.items?.[0];
        if (!pass) {
          const t = await templateByName(env, 'Northwind Member');
          pass = await issue(
            env,
            t.id,
            { holder: 'Webhook Card', memberId: 'JRN-HOOK' },
            { key: 'hook' },
          );
        }
        const detail = await passOf(owner, env, pass.id);
        await owner.patch(
          `/api/v1/passes/${pass.id}?orgId=${env.orgId}`,
          { input: { ...detail.personalization, note: `Update ${env.stamp}` } },
          { 'if-match': String(detail.version) },
        );
        return page(
          'org',
          `/admin/connections/webhooks/${env.vars.endpointId}?orgId=${env.orgId}`,
          {},
        );
      },
    },
    {
      title: 'A delivery',
      async run(env) {
        const owner = await env.api('org');
        const list: Json = await owner.get(
          `/api/v1/webhook-endpoints/${env.vars.endpointId}/deliveries?orgId=${env.orgId}`,
        );
        const first = list.items?.[0];
        if (!first) return { skip: 'the endpoint has no deliveries yet' };
        env.vars.eventId = first.eventId;
        return page(
          'org',
          `/admin/connections/webhooks/${env.vars.endpointId}?orgId=${env.orgId}`,
          {
            prepare: openDelivery,
          },
        );
      },
    },
    {
      title: 'Replay dialog',
      async run(env) {
        // The endpoint's Replay shows only once a delivery was attempted. No local target is allowed:
        // endpoint URLs go through safe-fetch, which refuses loopback and private addresses
        // (platform/safe-fetch.ts isPrivateIp), and capture endpoints are for developer sandboxes in
        // Test mode only (webhooks/capture.ts assertCaptureHome), not this org. A paused endpoint
        // sends nothing, and a pending delivery cannot be replayed.
        const owner = await env.api('org');
        const endpoint: Json = await owner.get(
          `/api/v1/webhook-endpoints/${env.vars.endpointId}?orgId=${env.orgId}`,
        );
        if (endpoint.lastSuccessAt == null && endpoint.lastFailureAt == null)
          return {
            skip: 'no delivery was attempted, so the endpoint has nothing to replay (SSRF rules refuse a local target)',
          };
        // The endpoint's own Replay opens the dialog; nothing is queued until it is confirmed.
        return page(
          'org',
          `/admin/connections/webhooks/${env.vars.endpointId}?orgId=${env.orgId}`,
          {
            prepare: async (p) => {
              await p.getByRole('button', { name: 'Replay' }).first().click();
            },
          },
        );
      },
    },
  ],
};
