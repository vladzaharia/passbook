import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import {
  PassDevicesSchema,
  PassEventListSchema,
  type PassSyncDeviceDto,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { handlePushDeliver } from '../delivery/jobs.ts';
import { getPass, type Pass } from '../passes/repo.ts';
import { updatePass } from '../passes/service.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { hashDevice } from './record.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
const fake = fakeAuth(ORIGIN);
const TOKEN = 'a'.repeat(64);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const wallet = (path: string, init: RequestInit = {}) =>
  app.request(`${ORIGIN}/wallet/v1${path}`, init, kit.env);
const api = (path: string, headers: Record<string, string> = fake.admin()) =>
  app.request(`${ORIGIN}/api/v1/passes${path}`, { headers }, kit.env);
const auth = (pass: Pass) => ({ authorization: `ApplePass ${pass.authToken}` });

const register = (pass: Pass, device: string) =>
  wallet(`/devices/${device}/registrations/${TYPE}/${pass.serial}`, {
    method: 'POST',
    headers: { ...auth(pass), 'content-type': 'application/json' },
    body: JSON.stringify({ pushToken: TOKEN }),
  });
const unregister = (pass: Pass, device: string) =>
  wallet(`/devices/${device}/registrations/${TYPE}/${pass.serial}`, {
    method: 'DELETE',
    headers: auth(pass),
  });
const check = (device: string) => wallet(`/devices/${device}/registrations/${TYPE}`);
const fetchPass = (pass: Pass, headers: Record<string, string> = {}) =>
  wallet(`/passes/${TYPE}/${pass.serial}`, { headers: { ...auth(pass), ...headers } });

async function devices(pass: Pass, headers?: Record<string, string>) {
  return PassDevicesSchema.parse(await (await api(`/${pass.id}/devices`, headers)).json());
}
async function kinds(pass: Pass, query = '') {
  const page = PassEventListSchema.parse(await (await api(`/${pass.id}/events${query}`)).json());
  return page.items.map((e) => e.kind);
}
const only = (list: PassSyncDeviceDto[], hash: string) => list.find((d) => d.device === hash);

async function push(pass: Pass) {
  await kit.settle();
  const row = await kit.env.DB.prepare(
    "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC, id DESC LIMIT 1",
  )
    .bind(pass.id)
    .first<{ id: string }>();
  await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
}

describe('a device from register to up to date', () => {
  it('walks unknown -> waiting -> current and records each step', async () => {
    const pass = await kit.pass();
    expect((await register(pass, 'dev-walk')).status).toBe(201);
    const hash = await hashDevice('dev-walk');
    expect(only((await devices(pass)).devices, hash)).toMatchObject({
      status: 'current',
      lastFetch: null,
      lastPush: null,
    });

    kit.clock.advance(5000);
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'New Name' } },
      { scope: null },
    );
    await push(pass);
    const waiting = await devices(pass);
    expect(only(waiting.devices, hash)).toMatchObject({
      status: 'waiting',
      lastPush: { ok: true, version: 2, httpStatus: 200 },
    });

    kit.clock.advance(3000);
    expect((await check('dev-walk')).status).toBe(200);
    expect((await fetchPass(pass)).status).toBe(200);
    const current = await devices(pass);
    expect(only(current.devices, hash)).toMatchObject({
      status: 'current',
      lastFetch: { version: 2, httpStatus: 200 },
    });

    expect(await kinds(pass, '?group=delivery')).toEqual(['push.sent', 'push.queued']);
    const fetched = await kinds(pass, '?kind=device.fetched,device.registered');
    expect(fetched).toEqual(['device.fetched', 'device.fetched', 'device.registered']);
  });

  it('shows a failing push and a device that left', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-bad');
    await register(pass, 'dev-left');
    kit.apns.results.set(TOKEN, { status: 400, reason: 'PayloadEmpty' });
    kit.clock.advance(2000);
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Other' } },
      { scope: null },
    );
    await push(pass);
    kit.apns.results.clear();
    const failing = await devices(pass);
    expect(failing.devices.map((d) => d.status)).toEqual(['push_failing', 'push_failing']);
    expect(failing.devices[0]?.lastPush).toMatchObject({ ok: false, reason: 'PayloadEmpty' });

    expect((await unregister(pass, 'dev-left')).status).toBe(200);
    const left = only((await devices(pass)).devices, await hashDevice('dev-left'));
    expect(left).toMatchObject({ status: 'removed', registeredAt: null });
    expect(left?.unregisteredAt).not.toBeNull();
  });

  it('records a dead token as unregistered', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-dead');
    kit.apns.results.set(TOKEN, { status: 410, reason: 'Unregistered' });
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Z' } },
      { scope: null },
    );
    await push(pass).catch(() => undefined);
    kit.apns.results.clear();
    expect(await kinds(pass, '?group=devices')).toContain('device.unregistered');
    expect((await devices(pass)).devices[0]?.status).toBe('removed');
  });

  it('records an unattributed fetch without a device', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-quiet');
    expect((await fetchPass(pass)).status).toBe(200);
    const page = PassEventListSchema.parse(
      await (await api(`/${pass.id}/events?kind=device.fetched`)).json(),
    );
    expect(page.items[0]).toMatchObject({ device: null, data: { step: 'file', status: 200 } });
  });
});

describe('fetch attribution', () => {
  it('credits a fetch to one device and leaves the other waiting', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-a');
    await register(pass, 'dev-b');
    kit.clock.advance(2000);
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Two Devices' } },
      { scope: null },
    );
    await push(pass);
    kit.clock.advance(1000);
    await check('dev-a');
    kit.clock.advance(10);
    await check('dev-b');
    expect((await fetchPass(pass)).status).toBe(200);
    await kit.settle();
    const list = (await devices(pass)).devices;
    expect(only(list, await hashDevice('dev-a'))?.status).toBe('current');
    expect(only(list, await hashDevice('dev-b'))?.status).toBe('waiting');
  });

  it('counts a device registered after the latest version as up to date', async () => {
    const pass = await kit.pass();
    // Registrations are stamped by the app's own clock, not the kit's.
    await kit.env.DB.prepare('UPDATE passes SET modified_at = 1 WHERE id = ?').bind(pass.id).run();
    await register(pass, 'dev-late');
    expect(only((await devices(pass)).devices, await hashDevice('dev-late'))?.status).toBe(
      'current',
    );
  });
});

describe('device log lines', () => {
  it('attach to the pass that owns the serial they name', async () => {
    const pass = await kit.pass();
    const other = await kit.pass();
    const res = await wallet('/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        logs: [
          `Register task (for device dev-secret-1, pass type ${TYPE}, serial number ${pass.serial}) failed to update`,
          'nothing about a pass',
          `pass type ${TYPE} serial number ${other.serial} ok`,
          `pass type pass.unknown.type serial number ${pass.serial} stray`,
        ],
      }),
    });
    expect(res.status).toBe(200);
    const log = PassEventListSchema.parse(
      await (await api(`/${pass.id}/events?kind=device.log`)).json(),
    );
    expect(log.items).toHaveLength(1);
    expect(log.items[0]?.data.line).toContain('failed to update');
    expect(log.items[0]?.data.line).not.toContain('dev-secret-1');
    expect(log.items[0]?.data.line).toContain(await hashDevice('dev-secret-1'));
    expect(await kinds(other, '?kind=device.log')).toEqual(['device.log']);
  });
});

describe('query groups', () => {
  it('rejects unknown groups and kinds', async () => {
    const pass = await kit.pass();
    expect((await api(`/${pass.id}/events?group=nope`)).status).toBe(422);
    expect((await api(`/${pass.id}/events?kind=pass.issued,bogus`)).status).toBe(422);
    expect(await kinds(pass, '?group=changes')).toEqual(['pass.issued']);
  });
});

describe('GET /passes/{id}/devices', () => {
  it('needs passes:read, stays inside the key org and works in both modes', async () => {
    const pass = await kit.pass();
    const other = await makeOrg(kit.fx, { name: 'Elsewhere' });
    expect((await api(`/${pass.id}/devices`, {})).status).toBe(401);
    expect((await api(`/${pass.id}/devices`, fake.user())).status).toBe(403);
    expect((await api(`/${pass.id}/devices`, fake.apiKey({ orgId: other.id }))).status).toBe(404);
    for (const headers of [fake.admin({ mode: 'test' }), fake.apiKey({ orgId: kit.org.id })])
      expect((await api(`/${pass.id}/devices`, headers)).status).toBe(200);
    expect((await getPass(kit.env.DB, pass.id))?.id).toBe(pass.id);
  });
});
