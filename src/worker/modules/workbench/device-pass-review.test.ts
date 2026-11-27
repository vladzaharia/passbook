import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevicePassResponseSchema } from '../../../shared/contracts/device-passes.ts';
import { all, first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { endSandboxDevicePasses } from './device-pass-end.ts';
import { type DevicePassKit, devicePassKit } from './device-pass-test-fixtures.ts';

let t: DevicePassKit;
beforeAll(async () => {
  t = await devicePassKit();
});
afterAll(() => t.unstub());

const PUSH = (n: number) => `${'ab'.repeat(15)}${n.toString(16).padStart(2, '0')}`;
type Dev = Awaited<ReturnType<typeof t.developer>>;

async function opened(d: Dev) {
  const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
  expect(res.status, await res.clone().text()).toBe(201);
  const dp = DevicePassResponseSchema.parse(await res.json()).devicePass;
  const code = new URL(dp.code?.url ?? '').pathname;
  const got = await t.raw(code);
  expect(got.status).toBe(200);
  const json = t.passJsonOf(new Uint8Array(await got.arrayBuffer()));
  return { dp, code, serial: json.serialNumber, token: json.authenticationToken };
}
type Opened = Awaited<ReturnType<typeof opened>>;

const wallet = (o: Opened, device: string, method: string, push?: string) =>
  t.raw(`/wallet/v1/devices/${device}/registrations/${t.passType}/${o.serial}`, {
    method,
    headers: { authorization: `ApplePass ${o.token}`, 'content-type': 'application/json' },
    body: push ? JSON.stringify({ pushToken: push }) : undefined,
  });
const fetched = (o: Opened) =>
  t.raw(`/wallet/v1/passes/${t.passType}/${o.serial}`, {
    headers: { authorization: `ApplePass ${o.token}` },
  });
const stateOf = (id: string) =>
  first<{ state: string; void_reason: string | null }>(
    t.kit.env.DB,
    'SELECT state, void_reason FROM device_passes WHERE id = ?',
    [id],
  );
const auditOf = (id: string) =>
  all<{ action: string; detail: string }>(
    t.kit.env.DB,
    "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'device_pass.%'",
    [id],
  );

describe('R2 review fixes', () => {
  it('M2: rotating phones does not get around the 3-phone limit', async () => {
    const d = await t.developer();
    const o = await opened(d);
    const ph = (n: number) => `${o.dp.id}-${n}`;
    for (const n of [1, 2, 3]) expect((await wallet(o, ph(n), 'POST', PUSH(n))).status).toBe(201);
    expect((await wallet(o, ph(1), 'DELETE')).status).toBe(200);
    // A fourth distinct phone is refused even though only two are registered now.
    expect((await wallet(o, ph(4), 'POST', PUSH(4))).status).toBe(401);
    expect(await stateOf(o.dp.id)).toEqual({ state: 'voided', void_reason: 'overshared' });
  });

  it('M2: a removed phone that returns is known, and removed phones leave the active reads', async () => {
    const d = await t.developer();
    const o = await opened(d);
    const ph = (n: number) => `${o.dp.id}-${n}`;
    for (const n of [1, 2, 3]) await wallet(o, ph(n), 'POST', PUSH(n));
    await wallet(o, ph(1), 'DELETE');
    expect(
      await first(
        t.kit.env.DB,
        'SELECT count(*) AS n FROM device_pass_devices WHERE device_pass_id = ? AND removed_at IS NULL',
        [o.dp.id],
      ),
    ).toEqual({ n: 2 });
    const list = await (await t.api('GET', '/developer/device-passes', d.browser)).json();
    expect(
      (list as { items: { id: string; deviceCount: number }[] }).items.find((i) => i.id === o.dp.id)
        ?.deviceCount,
    ).toBe(2);
    expect((await wallet(o, ph(1), 'POST', PUSH(1))).status).toBe(201);
    expect(await stateOf(o.dp.id)).toMatchObject({ state: 'active' });
  });

  it('L2: HEAD does not spend the one-time code', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const code = new URL(
      DevicePassResponseSchema.parse(await res.json()).devicePass.code?.url ?? '',
    ).pathname;
    expect((await t.raw(code, { method: 'HEAD' })).status).toBe(200);
    expect((await t.raw(code)).status).toBe(200);
  });

  it('L1: the one-time code is not stored in the idempotency table', async () => {
    const d = await t.developer();
    const res = await t.api(
      'POST',
      '/developer/device-passes',
      d.browser,
      { passId: d.passId },
      'no-code-at-rest',
    );
    const dp = DevicePassResponseSchema.parse(await res.json()).devicePass;
    const secret = (dp.code?.url ?? '').split('/d/')[1] ?? 'x';
    const rows = await all<{ body: string }>(
      t.kit.env.DB,
      'SELECT body FROM idempotent_requests WHERE body LIKE ?',
      [`%${dp.id}%`],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.body).not.toContain(secret);
  });

  it('L3: with the flag off a phone still gets the voided copy', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await wallet(o, `${o.dp.id}-1`, 'POST', PUSH(1));
    await t.api('DELETE', `/developer/device-passes/${o.dp.id}`, d.browser);
    t.flag(false);
    expect((await fetched(o)).status).toBe(200);
    expect(
      (await t.raw(`/wallet/v1/devices/${o.dp.id}-1/registrations/${t.passType}`)).status,
    ).toBe(200);
    t.flag(true);
  });

  it('L6: Add again works at once after expiry, before the sweep', async () => {
    const d = await t.developer();
    const o = await opened(d);
    t.kit.clock.advance(24 * 3_600_000 + 1_000);
    const again = await t.api('POST', `/developer/device-passes/${o.dp.id}/again`, d.browser);
    expect(again.status, await again.clone().text()).toBe(201);
    expect(await stateOf(o.dp.id)).toEqual({ state: 'expired', void_reason: 'expired' });
    expect((await auditOf(o.dp.id)).map((a) => a.action)).toContain('device_pass.expired');
  });

  it('L7: a code used after the source pass is gone ends the pass with an audit', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const dp = DevicePassResponseSchema.parse(await res.json()).devicePass;
    await t.api('POST', `/passes/${d.passId}/void`, d.headers, {});
    const got = await t.raw(new URL(dp.code?.url ?? '').pathname);
    expect(got.status).toBe(410);
    const voided = (await auditOf(dp.id)).find((a) => a.action === 'device_pass.voided');
    expect(JSON.parse(voided?.detail ?? '{}')).toMatchObject({ reason: 'pass_gone' });
  });

  it('L8: closing a sandbox ends its open device passes', async () => {
    const d = await t.developer();
    const o = await opened(d);
    const row = await first<{ org_id: string }>(
      t.kit.env.DB,
      'SELECT org_id FROM device_passes WHERE id = ?',
      [o.dp.id],
    );
    await endSandboxDevicePasses(
      createServiceContext(t.kit.env, { clock: t.kit.clock }),
      row?.org_id ?? '',
    );
    expect(await stateOf(o.dp.id)).toEqual({ state: 'voided', void_reason: 'platform' });
    expect((await auditOf(o.dp.id)).map((a) => a.action)).toContain('device_pass.voided');
  });
});
