import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  deliverNow,
  deliveryOf,
  endpointOf,
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  setupRig,
  stubNet,
} from './deliver-test-fixtures.ts';
import { ALL_TYPES, seedEndpoint } from './webhooks-test-fixtures.ts';

let rig: Rig;
let net: Net;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => net.restore());

async function one() {
  const ep = await endpointWithSecret(rig, { orgId: rig.orgId, eventTypes: ALL_TYPES });
  const pass = await rig.kit.pass();
  return { ep, pass };
}

describe('re-checks at send time', () => {
  it('cancels a type the endpoint no longer subscribes to', async () => {
    const { ep } = await one();
    await run(rig.db, 'UPDATE webhook_endpoints SET event_types = ? WHERE id = ?', [
      '["pass.voided"]',
      ep,
    ]);
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect(await deliveryOf(rig.db, ep)).toMatchObject({
      state: 'cancelled',
      last_error: 'UNSUBSCRIBED',
      attempts: 0,
    });
  });

  it('cancels a template the endpoint no longer includes', async () => {
    const { ep } = await one();
    await run(rig.db, 'UPDATE webhook_endpoints SET template_ids = ? WHERE id = ?', [
      '["some-other-template"]',
      ep,
    ]);
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('UNSUBSCRIBED');
  });

  it('cancels when the org is no longer active', async () => {
    const { ep } = await one();
    await run(rig.db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [rig.orgId]);
    try {
      await deliverNow(rig, ep);
    } finally {
      await run(rig.db, "UPDATE orgs SET status = 'active' WHERE id = ?", [rig.orgId]);
    }
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('ORG_INACTIVE');
  });

  it('cancels when the pass was quarantined after the event was written', async () => {
    const { ep, pass } = await one();
    await run(rig.db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('PASS_QUARANTINED');
  });
});

describe('secrets are bound (proof 7)', () => {
  it('a secret row copied to another endpoint fails to decrypt: SECRET_UNAVAILABLE, nothing sent', async () => {
    const epA = await endpointWithSecret(rig, { orgId: rig.orgId, secret: 'whsec_a' });
    const epB = await seedEndpoint(rig.db, { orgId: rig.orgId });
    await run(
      rig.db,
      `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek,
         ciphertext, created_at)
       SELECT 'copied', ?, org_id, mode, kek_version, iv, wrapped_dek, ciphertext, created_at
       FROM webhook_endpoint_secrets WHERE endpoint_id = ?`,
      [epB, epA],
    );
    await rig.kit.pass();
    await deliverNow(rig, epB);
    expect(net.calls).toEqual([]);
    expect(await deliveryOf(rig.db, epB)).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: 'SECRET_UNAVAILABLE',
    });
    // The platform's fault, not the endpoint's: nothing counts toward disabling it.
    expect((await endpointOf(rig.db, epB))?.consecutive_failures).toBe(0);
    // The endpoint that owns the secret still delivers.
    await deliverNow(rig, epA);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.url).toContain(epA);
    expect((await deliveryOf(rig.db, epA))?.state).toBe('delivered');
  });
});
