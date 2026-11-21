import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhook, WebhookSignatureError } from '../../sdk/typescript/src/index.ts';
import {
  deliverNow,
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  seedSecret,
  setupRig,
  stubNet,
} from '../../src/worker/modules/webhooks/deliver-test-fixtures.ts';

let rig: Rig;
let net: Net;
const HOUR = 3_600_000;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => net.restore());

/** The server's real signed delivery of a pass.issued event. */
async function delivery(secrets: string[] = ['whsec_test']) {
  const [first, ...older] = secrets;
  const ep = await endpointWithSecret(rig, { orgId: rig.orgId, secret: first as string });
  for (const value of older)
    await seedSecret(rig, { endpointId: ep, value, expiresAt: rig.kit.clock.now() + HOUR });
  const pass = await rig.kit.pass();
  await deliverNow(rig, ep);
  const call = net.calls[0];
  if (!call) throw new Error('No delivery');
  return { call, pass, now: Math.floor(rig.kit.clock.now() / 1000) };
}

const reason = async (run: Promise<unknown>) => {
  const error = await run.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WebhookSignatureError);
  return (error as WebhookSignatureError).reason;
};

describe('verifyWebhook against the server', () => {
  it('verifies a real delivery and returns the typed event', async () => {
    const { call, pass, now } = await delivery();
    const event = await verifyWebhook(call.body, call.headers, 'whsec_test', { now });
    expect(event).toMatchObject({ type: 'pass.issued', orgId: rig.orgId, pass: { id: pass.id } });
    expect(event.id).toBe(call.headers['x-passbook-event-id']);
  });

  it('takes bytes, a Headers object and a secret list', async () => {
    const { call, now } = await delivery();
    const bytes = new TextEncoder().encode(call.body);
    const headers = new Headers(call.headers);
    await expect(
      verifyWebhook(bytes, headers, ['nope', 'whsec_test'], { now }),
    ).resolves.toBeDefined();
    await expect(
      verifyWebhook(bytes.buffer as ArrayBuffer, call.headers, 'whsec_test', { now }),
    ).resolves.toBeDefined();
  });

  it('accepts either secret while one is rotating out', async () => {
    const { call, now } = await delivery(['whsec_new', 'whsec_old']);
    expect(call.headers['x-passbook-signature']?.split(', ')).toHaveLength(2);
    for (const secret of ['whsec_new', 'whsec_old'])
      await expect(verifyWebhook(call.body, call.headers, secret, { now })).resolves.toBeDefined();
  });

  it('refuses a wrong secret, a changed body and a replayed timestamp', async () => {
    const { call, now } = await delivery();
    expect(await reason(verifyWebhook(call.body, call.headers, 'whsec_other', { now }))).toBe(
      'mismatch',
    );
    expect(await reason(verifyWebhook(`${call.body} `, call.headers, 'whsec_test', { now }))).toBe(
      'mismatch',
    );
    const later = { now: now + 301 };
    expect(await reason(verifyWebhook(call.body, call.headers, 'whsec_test', later))).toBe(
      'timestamp_out_of_range',
    );
    await expect(
      verifyWebhook(call.body, call.headers, 'whsec_test', {
        now: now + 301,
        toleranceSeconds: 600,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses missing and malformed headers', async () => {
    const { call, now } = await delivery();
    const { 'x-passbook-signature': _signature, ...unsigned } = call.headers;
    expect(await reason(verifyWebhook(call.body, unsigned, 'whsec_test', { now }))).toBe(
      'missing_header',
    );
    const bad = { ...call.headers, 'x-passbook-signature': 'v1=zz' };
    expect(await reason(verifyWebhook(call.body, bad, 'whsec_test', { now }))).toBe('malformed');
    const badTime = { ...call.headers, 'x-passbook-timestamp': 'soon' };
    expect(await reason(verifyWebhook(call.body, badTime, 'whsec_test', { now }))).toBe(
      'malformed',
    );
  });
});
