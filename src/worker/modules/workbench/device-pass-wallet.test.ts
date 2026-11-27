import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { DevicePassResponseSchema } from '../../../shared/contracts/device-passes.ts';
import { all, first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { sweepDevicePasses } from './device-pass-sync.ts';
import { type DevicePassKit, devicePassKit } from './device-pass-test-fixtures.ts';

let t: DevicePassKit;
beforeAll(async () => {
  t = await devicePassKit();
});
afterAll(() => t.unstub());

const PUSH = (n: number) => `${'ab'.repeat(15)}${n.toString(16).padStart(2, '0')}`;
/** A device id of its own: a phone is shared by nothing else in the file. */
const ph = (o: { dp: { id: string } }, n: number) => `${o.dp.id}-${n}`;
const ctx = () => createServiceContext(t.kit.env, { clock: t.kit.clock });

type Dev = Awaited<ReturnType<typeof t.developer>>;

/** A device pass made and opened: its id, the code's pkpass bytes, the serial and the token inside. */
async function opened(d: Dev, passId = d.passId) {
  const res = await t.api('POST', '/developer/device-passes', d.browser, { passId });
  expect(res.status, await res.clone().text()).toBe(201);
  const dp = DevicePassResponseSchema.parse(await res.json()).devicePass;
  const url = new URL(dp.code?.url ?? '');
  const got = await t.raw(url.pathname);
  expect(got.status).toBe(200);
  const bytes = new Uint8Array(await got.arrayBuffer());
  const json = t.passJsonOf(bytes);
  return {
    dp,
    code: url.pathname,
    bytes,
    json,
    serial: json.serialNumber,
    token: json.authenticationToken,
  };
}
type Opened = Awaited<ReturnType<typeof opened>>;

const wallet = (o: Opened, device: string, method: string, push?: string, auth = o.token) =>
  t.raw(`/wallet/v1/devices/${device}/registrations/${t.passType}/${o.serial}`, {
    method,
    headers: { authorization: `ApplePass ${auth}`, 'content-type': 'application/json' },
    body: push ? JSON.stringify({ pushToken: push }) : undefined,
  });
const fetched = (o: Opened, headers: Record<string, string> = {}, auth = o.token) =>
  t.raw(`/wallet/v1/passes/${t.passType}/${o.serial}`, {
    headers: { authorization: `ApplePass ${auth}`, ...headers },
  });
const events = (passId: string) =>
  all<{ kind: string; data: string; device: string | null }>(
    t.kit.env.DB,
    'SELECT kind, data, device FROM pass_events WHERE pass_id = ? ORDER BY id',
    [passId],
  );
/** The sample input with its first text field changed: a new version of the pass. */
const renamed = (d: Dev): Record<string, unknown> => {
  const key = Object.keys(d.sample).find((k) => typeof d.sample[k] === 'string') ?? '';
  return { ...d.sample, [key]: 'Renamed' };
};
const stateOf = (id: string) =>
  first<{ state: string; void_reason: string | null }>(
    t.kit.env.DB,
    'SELECT state, void_reason FROM device_passes WHERE id = ?',
    [id],
  );

describe('the download', () => {
  it('serves the signed pass once, under the device-test identity, with every override', async () => {
    const d = await t.developer();
    const o = await opened(d);
    const { json } = o;
    expect(json).toMatchObject({
      passTypeIdentifier: t.passType,
      organizationName: 'PassBook Test',
      sharingProhibited: true,
      serialNumber: `dp_${o.dp.id}`,
      expirationDate: new Date(o.dp.expiresAt).toISOString(),
      webServiceURL: `${t.kit.env.PUBLIC_BASE_URL}/wallet`,
    });
    expect(o.token).toMatch(/^[0-9a-f]{32}$/);
    const style = Object.values(json).find(
      (v) => typeof v === 'object' && v !== null && 'backFields' in v,
    ) as { backFields: { key: string; value: string }[] };
    expect(style.backFields[0]).toMatchObject({
      key: 'passbook_device_test',
      value: 'Test pass from a developer sandbox. Not valid for entry, payment or ID.',
    });
    expect(await stateOf(o.dp.id)).toMatchObject({ state: 'active' });
    // The token is never stored: the row keeps a nonce, not the token or the code.
    const row = JSON.stringify(
      await first(t.kit.env.DB, 'SELECT * FROM device_passes WHERE id = ?', [o.dp.id]),
    );
    expect(row).not.toContain(o.token);
    expect(row).not.toContain(o.code.split('/d/')[1] ?? 'x');
    const again = await t.raw(o.code);
    expect(again.status).toBe(410);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(again.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('answers the pkpass with no-store and no-referrer', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const url = new URL(
      DevicePassResponseSchema.parse(await res.json()).devicePass.code?.url ?? '',
    );
    const got = await t.raw(url.pathname);
    expect(got.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('gives one of two simultaneous requests the pass and the other 410', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const path = new URL(
      DevicePassResponseSchema.parse(await res.json()).devicePass.code?.url ?? '',
    ).pathname;
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => t.raw(path)))).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 410)).toHaveLength(5);
  });

  it('refuses an expired or unknown code with the same 410', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const path = new URL(
      DevicePassResponseSchema.parse(await res.json()).devicePass.code?.url ?? '',
    ).pathname;
    t.kit.clock.advance(11 * 60_000);
    expect((await t.raw(path)).status).toBe(410);
    expect((await t.raw(`/d/${'z'.repeat(43)}`)).status).toBe(410);
  });

  it('gives the code back when the build fails, so the phone can try again', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const path = new URL(
      DevicePassResponseSchema.parse(await res.json()).devicePass.code?.url ?? '',
    ).pathname;
    await t.identityIssuing(false);
    expect((await t.raw(path)).status).toBe(503);
    await t.identityIssuing(true);
    expect((await t.raw(path)).status).toBe(200);
  });

  it('replaces the code on request (the old one dies), up to 5 codes, and never after it was opened', async () => {
    const d = await t.developer();
    const res = await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId });
    const first1 = DevicePassResponseSchema.parse(await res.json()).devicePass;
    const codes = [first1.code?.url ?? ''];
    for (let i = 0; i < 4; i++) {
      const next = await t.api('POST', `/developer/device-passes/${first1.id}/code`, d.browser);
      expect(next.status, await next.clone().text()).toBe(201);
      codes.push(DevicePassResponseSchema.parse(await next.json()).devicePass.code?.url ?? '');
    }
    await expectProblem(
      await t.api('POST', `/developer/device-passes/${first1.id}/code`, d.browser),
      409,
      'DEVICE_PASS_CODE_LIMIT',
    );
    expect((await t.raw(new URL(codes[0] ?? '').pathname)).status).toBe(410);
    expect((await t.raw(new URL(codes[4] ?? '').pathname)).status).toBe(200);
    await expectProblem(
      await t.api('POST', `/developer/device-passes/${first1.id}/code`, d.browser),
      409,
      'DEVICE_PASS_CODE_USED',
    );
  });
});

describe('Wallet web service for a device pass', () => {
  it('registers and unregisters a phone, and the events reach the source pass', async () => {
    const d = await t.developer();
    const o = await opened(d);
    expect((await wallet(o, ph(o, 1), 'POST', PUSH(1))).status).toBe(201);
    expect((await wallet(o, ph(o, 1), 'POST', PUSH(1))).status).toBe(200);
    const feed = async () =>
      (
        (await (await t.api('GET', `/events?passId=${d.passId}`, d.headers)).json()) as {
          items: { type: string; data: Record<string, unknown> }[];
        }
      ).items;
    const installed = (await feed()).find((e) => e.type === 'pass.installed');
    expect(installed?.data).toMatchObject({
      wallet: 'apple',
      deviceCount: 1,
      firstDevice: true,
      devicePass: true,
      devicePassId: o.dp.id,
    });
    const devices = await (await t.api('GET', `/passes/${d.passId}/devices`, d.headers)).json();
    expect((devices as { devices: { devicePass?: boolean }[] }).devices).toMatchObject([
      { devicePass: true },
    ]);
    expect((await wallet(o, ph(o, 1), 'DELETE')).status).toBe(200);
    const uninstalled = (await feed()).find((e) => e.type === 'pass.uninstalled');
    expect(uninstalled?.data).toMatchObject({ deviceCount: 0, lastDevice: true, devicePass: true });
    const listed = await (await t.api('GET', '/developer/device-passes', d.browser)).json();
    expect(
      (listed as { items: { id: string; deviceCount: number }[] }).items.find(
        (i) => i.id === o.dp.id,
      ),
    ).toMatchObject({ deviceCount: 0 });
  });

  it('refuses a wrong token, a wrong pass type and an unopened pass with 401', async () => {
    const d = await t.developer();
    const o = await opened(d);
    expect((await wallet(o, ph(o, 1), 'POST', PUSH(1), 'wrong')).status).toBe(401);
    expect((await fetched(o, {}, 'wrong')).status).toBe(401);
    const other = await t.raw(`/wallet/v1/passes/pass.im.plrs.wallet/${o.serial}`, {
      headers: { authorization: `ApplePass ${o.token}` },
    });
    expect(other.status).toBe(401);
  });

  it('voids a pass shared with a 4th phone, blocks the developer and tells the others', async () => {
    const d = await t.developer();
    const o = await opened(d);
    for (const n of [1, 2, 3])
      expect((await wallet(o, ph(o, n), 'POST', PUSH(n))).status).toBe(201);
    t.apns.sent.length = 0;
    expect((await wallet(o, ph(o, 4), 'POST', PUSH(4))).status).toBe(401);
    await t.settle();
    expect(await stateOf(o.dp.id)).toEqual({ state: 'voided', void_reason: 'overshared' });
    const actions = (
      await all<{ action: string }>(
        t.kit.env.DB,
        "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'device_pass.%'",
        [o.dp.id],
      )
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['device_pass.overshared', 'device_pass.voided']),
    );
    expect(new Set(t.apns.sent.map((s) => s.token))).toEqual(new Set([PUSH(1), PUSH(2), PUSH(3)]));
    await expectProblem(
      await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId }),
      403,
      'DEVICE_PASS_BLOCKED',
    );
    // A platform admin clears it.
    const admin = await t.outsider(['admin', 'user']);
    const user = d.user.id;
    expect(
      (await t.api('POST', '/platform/device-passes/unblock', admin.headers, { userId: user }))
        .status,
    ).toBe(200);
    expect(
      (await t.api('POST', '/developer/device-passes', d.browser, { passId: d.passId })).status,
    ).toBe(201);
  });

  it('refuses a registration on an ended pass', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await t.api('DELETE', `/developer/device-passes/${o.dp.id}`, d.browser);
    expect((await wallet(o, ph(o, 1), 'POST', PUSH(1))).status).toBe(401);
  });
});

describe('rebuild, push and expiry', () => {
  it('rebuilds on a new version of the source pass and pushes the phone', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await wallet(o, ph(o, 1), 'POST', PUSH(1));
    const tag = (await (
      await t.raw(`/wallet/v1/devices/${ph(o, 1)}/registrations/${t.passType}`)
    ).json()) as { serialNumbers: string[]; lastUpdated: string };
    expect(tag.serialNumbers).toEqual([o.serial]);
    expect(
      (
        await t.raw(
          `/wallet/v1/devices/${ph(o, 1)}/registrations/${t.passType}?passesUpdatedSince=${tag.lastUpdated}`,
        )
      ).status,
    ).toBe(204);
    const first1 = await fetched(o);
    expect(first1.status).toBe(200);
    expect(
      (await fetched(o, { 'if-modified-since': first1.headers.get('last-modified') ?? '' })).status,
    ).toBe(304);

    t.kit.clock.advance(5_000);
    t.apns.sent.length = 0;
    const res = await t.api('PATCH', `/passes/${d.passId}`, d.headers, {
      input: renamed(d),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    await t.settle();
    expect(t.apns.sent.some((s) => s.token === PUSH(1))).toBe(true);
    const moved = await t.raw(
      `/wallet/v1/devices/${ph(o, 1)}/registrations/${t.passType}?passesUpdatedSince=${tag.lastUpdated}`,
    );
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { serialNumbers: string[] }).serialNumbers).toEqual([o.serial]);
    const next = await fetched(o, {
      'if-modified-since': first1.headers.get('last-modified') ?? '',
    });
    expect(next.status).toBe(200);
    expect(JSON.stringify(t.passJsonOf(new Uint8Array(await next.arrayBuffer())))).toContain(
      'Renamed',
    );
  });

  it('reports a failed push on the source pass, and drops a phone APNs says is gone', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await wallet(o, ph(o, 1), 'POST', PUSH(1));
    await wallet(o, ph(o, 2), 'POST', PUSH(2));
    t.apns.results.set(PUSH(1), { status: 500, reason: 'InternalServerError' });
    t.apns.results.set(PUSH(2), { status: 410, reason: 'Unregistered' });
    await t.api('DELETE', `/developer/device-passes/${o.dp.id}`, d.browser);
    await t.settle();
    const rows = await events(d.passId);
    const failed = rows.filter((e) => e.kind === 'push.failed');
    expect(failed).toHaveLength(2);
    expect(JSON.parse(failed[0]?.data ?? '{}')).toMatchObject({
      devicePass: true,
      devicePassId: o.dp.id,
    });
    expect(rows.filter((e) => e.kind === 'device.unregistered')).toHaveLength(1);
    t.apns.results.clear();
  });

  it('expires after 24 hours, pushes, serves the voided copy, and purges 30 days later', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await wallet(o, ph(o, 1), 'POST', PUSH(1));
    t.kit.clock.advance(24 * 3_600_000 + 1_000);
    t.apns.sent.length = 0;
    await sweepDevicePasses(ctx());
    expect(await stateOf(o.dp.id)).toEqual({ state: 'expired', void_reason: 'expired' });
    expect(t.apns.sent.map((s) => s.token)).toContain(PUSH(1));
    const served = await fetched(o);
    expect(served.status).toBe(200);
    const ended = t.passJsonOf(new Uint8Array(await served.arrayBuffer()));
    expect(ended).toMatchObject({ voided: true, organizationName: 'PassBook Test' });
    expect(ended).not.toHaveProperty('barcodes');
    t.kit.clock.advance(31 * 86_400_000);
    await sweepDevicePasses(ctx());
    expect(await stateOf(o.dp.id)).toBeNull();
  });

  it('ends a device pass whose source pass was voided', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await t.api('POST', `/passes/${d.passId}/void`, d.headers, {});
    await t.settle();
    await sweepDevicePasses(ctx());
    expect(await stateOf(o.dp.id)).toEqual({ state: 'voided', void_reason: 'pass_gone' });
  });
});

describe('Add again', () => {
  it('needs the old pass to have ended, and counts against the 5', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await expectProblem(
      await t.api('POST', `/developer/device-passes/${o.dp.id}/again`, d.browser),
      409,
      'DEVICE_PASS_STILL_OPEN',
    );
    await t.api('DELETE', `/developer/device-passes/${o.dp.id}`, d.browser);
    const again = await t.api('POST', `/developer/device-passes/${o.dp.id}/again`, d.browser);
    expect(again.status, await again.clone().text()).toBe(201);
    const fresh = DevicePassResponseSchema.parse(await again.json()).devicePass;
    expect(fresh).toMatchObject({ passId: d.passId, state: 'pending' });
    expect(fresh.id).not.toBe(o.dp.id);
    expect(
      await first(t.kit.env.DB, 'SELECT again_of FROM device_passes WHERE id = ?', [fresh.id]),
    ).toEqual({ again_of: o.dp.id });
    const other = await t.developer();
    await expectProblem(
      await t.api('POST', `/developer/device-passes/${o.dp.id}/again`, other.browser),
      404,
      'DEVICE_PASS_NOT_FOUND',
    );
  });
});

describe('flag off and the platform kill switch', () => {
  it('serves nothing to a phone with the flag off, and the publish hook writes nothing', async () => {
    const d = await t.developer();
    const o = await opened(d);
    await wallet(o, ph(o, 1), 'POST', PUSH(1));
    t.flag(false);
    expect((await fetched(o)).status).toBe(401);
    expect((await wallet(o, ph(o, 2), 'POST', PUSH(2))).status).toBe(401);
    expect((await t.raw(`/wallet/v1/devices/${ph(o, 1)}/registrations/${t.passType}`)).status).toBe(
      204,
    );
    const before = await first<{ source_version: number }>(
      t.kit.env.DB,
      'SELECT source_version FROM device_passes WHERE id = ?',
      [o.dp.id],
    );
    await t.api('PATCH', `/passes/${d.passId}`, d.headers, { input: renamed(d) });
    await t.settle();
    expect(
      await first(t.kit.env.DB, 'SELECT source_version FROM device_passes WHERE id = ?', [o.dp.id]),
    ).toEqual(before);
    const devices = await (await t.api('GET', `/passes/${d.passId}/devices`, d.headers)).json();
    expect((devices as { devices: unknown[] }).devices).toEqual([]);
    t.flag(true);
  });

  it('lets a platform admin void every pass of a developer, flag on or off, and no one else', async () => {
    const d = await t.developer();
    const o = await opened(d);
    const second = await opened(d);
    const person = await t.outsider(['user', 'developer']);
    expect(
      (await t.api('POST', '/platform/device-passes/void', person.headers, { userId: d.user.id }))
        .status,
    ).toBe(403);
    const admin = await t.outsider(['admin', 'user']);
    t.flag(false);
    const res = await t.api('POST', '/platform/device-passes/void', admin.headers, {
      userId: d.user.id,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ voided: 2 });
    t.flag(true);
    expect(await stateOf(o.dp.id)).toEqual({ state: 'voided', void_reason: 'platform' });
    expect(await stateOf(second.dp.id)).toEqual({ state: 'voided', void_reason: 'platform' });
  });
});
