import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { hashDevice } from '../events/record.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updatePass } from '../passes/service.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { beginTransfer, interveneAtD1 } from './credential-transfer-test-fixtures.ts';
import { pendingAppleFetchDevice } from './repo-events.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
const push = (letter: string) => letter.repeat(64);
// Storage lasts for the whole file; the credential keyset is immutable, so each case gets its own D1.
const makeEnv = installKeysetTestEnv();
const testDatabase = async () => (await makeEnv()).DB;

function client(kit: Kit) {
  const app = createApp({ clock: kit.clock });
  const call = (path: string, init: RequestInit = {}, env: AppEnv = kit.env) =>
    app.request(`${ORIGIN}/wallet/v1${path}`, init, env);
  const auth = (pass: Pass) => ({ authorization: `ApplePass ${pass.authToken}` });
  const register = (pass: Pass, device: string, env: AppEnv = kit.env, value = push('a')) =>
    call(
      `/devices/${device}/registrations/${TYPE}/${pass.serial}`,
      {
        method: 'POST',
        headers: { ...auth(pass), 'content-type': 'application/json' },
        body: JSON.stringify({ pushToken: value }),
      },
      env,
    );
  const remove = (pass: Pass, device: string, env: AppEnv = kit.env) =>
    call(
      `/devices/${device}/registrations/${TYPE}/${pass.serial}`,
      { method: 'DELETE', headers: auth(pass) },
      env,
    );
  const latest = (pass: Pass, env: AppEnv = kit.env, extra: Record<string, string> = {}) =>
    call(`/passes/${TYPE}/${pass.serial}`, { headers: { ...auth(pass), ...extra } }, env);
  const list = (device: string, env: AppEnv = kit.env) =>
    call(`/devices/${device}/registrations/${TYPE}`, {}, env);
  return { call, auth, register, remove, latest, list };
}

describe('Apple credential transfer fences', () => {
  it('blocks pending credentials without disturbing another pass on the same device', async () => {
    const t = await setupSamsungCallbacks({ db: await testDatabase() });
    const { kit, pass } = t;
    const http = client(kit);
    const other = await kit.pass();
    expect((await http.register(pass, 'apple-transfer-shared')).status).toBe(201);
    expect((await http.register(other, 'apple-transfer-shared')).status).toBe(201);
    expect((await http.latest(pass)).status).toBe(200);
    const before = await http.list('apple-transfer-shared');
    const beforeBody = z.object({ serialNumbers: z.array(z.string()) }).parse(await before.json());
    expect(beforeBody.serialNumbers.sort()).toEqual([pass.serial, other.serial].sort());
    expect((await beginTransfer(kit, pass)).state).toBe('pending');
    expect((await http.register(pass, 'apple-transfer-shared', kit.env, push('b'))).status).toBe(
      401,
    );
    expect((await http.register(pass, 'apple-transfer-new')).status).toBe(401);
    expect((await http.remove(pass, 'apple-transfer-shared')).status).toBe(401);
    const denied = await http.latest(pass, kit.env, { 'if-none-match': `"${pass.objectSha256}"` });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('etag')).toBeNull();
    const listed = await http.list('apple-transfer-shared');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ serialNumbers: [other.serial] });
    expect((await http.latest(other)).status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM devices WHERE device_id = ?', ['apple-transfer-new']),
    ).toBeNull();
  }, 120_000);

  const races = [
    {
      name: 'new registration',
      method: 'batch',
      sql: /INSERT INTO registrations/i,
      existing: false,
      remove: false,
    },
    {
      name: 'push-token update',
      method: 'run',
      sql: /UPDATE registrations SET push_token/i,
      existing: true,
      remove: false,
    },
    {
      name: 'unregistration',
      method: 'batch',
      sql: /DELETE FROM registrations/i,
      existing: true,
      remove: true,
    },
  ] as const;

  it.each(races)(
    'fences $name when transfer starts immediately before the D1 write',
    async (race) => {
      const { kit, pass } = await setupSamsungCallbacks({ db: await testDatabase() });
      const http = client(kit);
      const device = `race-${race.name.replaceAll(' ', '-')}`;
      if (race.existing) expect((await http.register(pass, device)).status).toBe(201);
      const gate = interveneAtD1(
        kit.env.DB,
        { method: race.method, sql: race.sql, when: 'before' },
        async () => {
          expect((await beginTransfer(kit, pass)).state).toBe('pending');
        },
      );
      const env = { ...kit.env, DB: gate.db } as AppEnv;
      const response = race.remove
        ? await http.remove(pass, device, env)
        : await http.register(pass, device, env, push('b'));
      expect(gate.hits()).toBe(1);
      expect(response.status).toBe(401);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      if (!race.existing)
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM devices WHERE device_id = ?', [device]),
        ).toBeNull();
    },
    120_000,
  );

  it('does not write a delayed registration event into a pending transfer', async () => {
    const { kit, pass } = await setupSamsungCallbacks({ db: await testDatabase() });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /INSERT INTO registrations/i,
        when: 'after',
      },
      async () => {
        expect((await beginTransfer(kit, pass)).state).toBe('pending');
      },
    );
    const response = await client(kit).register(pass, 'race-event', {
      ...kit.env,
      DB: gate.db,
    } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(401);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'device.registered'",
        [pass.id],
      ),
    ).toBeNull();
  }, 120_000);

  it('rechecks a captured update list after a transfer starts during event recording', async () => {
    const { kit, pass } = await setupSamsungCallbacks({ db: await testDatabase() });
    const other = await kit.pass();
    const http = client(kit);
    expect((await http.register(pass, 'race-list')).status).toBe(201);
    expect((await http.register(other, 'race-list')).status).toBe(201);
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'all',
        sql: /FROM registrations r JOIN passes p[\s\S]*p\.revision > \?/i,
        when: 'after',
      },
      async () => {
        expect((await beginTransfer(kit, pass)).state).toBe('pending');
      },
    );
    const result = await http.list('race-list', { ...kit.env, DB: gate.db } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ serialNumbers: [other.serial] });
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_events
      WHERE pass_id = ? AND kind = 'device.fetched' AND json_extract(data, '$.step') = 'listed'`,
        [pass.id],
      ),
    ).toBeNull();
  }, 120_000);

  it('rechecks the captured serial after the pass file is read from R2', async () => {
    const { kit, pass } = await setupSamsungCallbacks({ db: await testDatabase() });
    let hits = 0;
    const bucket = new Proxy(kit.env.BUCKET, {
      get(target, property) {
        if (property === 'get')
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.get, target, args);
            hits++;
            expect((await beginTransfer(kit, pass)).state).toBe('pending');
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await client(kit).latest(pass, { ...kit.env, BUCKET: bucket } as AppEnv);
    expect(hits).toBe(1);
    expect(response.status).toBe(401);
    expect(response.headers.get('etag')).toBeNull();
  }, 120_000);

  it('does not return 304 for a transfer beginning after the initial authorization', async () => {
    const { kit, pass } = await setupSamsungCallbacks({ db: await testDatabase() });
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /^\s*SELECT 1 FROM passes p WHERE p\.id = \?/i,
        when: 'before',
        occurrence: 2,
      },
      async () => {
        expect((await beginTransfer(kit, pass)).state).toBe('pending');
      },
    );
    const response = await client(kit).latest(pass, { ...kit.env, DB: gate.db } as AppEnv, {
      'if-none-match': `"${pass.objectSha256}"`,
    });
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(401);
    expect(response.headers.get('etag')).toBeNull();
  }, 120_000);
  it('rotates the installed credential and lists only registrations of the new incarnation', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const old = await kit.pass({ memberName: 'Previous Holder' });
    const http = client(kit);
    expect((await http.register(old, 'old-wallet')).status).toBe(201);
    expect((await http.latest(old)).status).toBe(200);
    expect((await beginTransfer(kit, old)).state).toBe('completed');
    const rotated = await getPass(kit.env.DB, old.id);
    if (!rotated) throw new Error('Missing transferred pass');
    expect(rotated.credentialGeneration).toBe(old.credentialGeneration + 1);
    expect(rotated.serial).not.toBe(old.serial);
    expect(rotated.authToken).not.toBe(old.authToken);
    expect(rotated.holderEmail).toBe('next-holder@example.test');
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [old.id]),
    ).toBeNull();

    expect((await http.latest(old)).status).toBe(401);
    expect((await http.latest({ ...rotated, authToken: old.authToken })).status).toBe(401);
    expect((await http.latest({ ...old, authToken: rotated.authToken })).status).toBe(401);
    expect((await http.register(old, 'old-wallet')).status).toBe(401);

    // Even a leftover source-generation row cannot reveal the replacement serial.
    await run(
      kit.env.DB,
      `INSERT INTO registrations
      (device_id, identity_id, pass_id, push_token, created_at, credential_generation)
      VALUES (?, ?, ?, ?, ?, ?)`,
      ['old-wallet', old.identityId, old.id, push('a'), kit.clock.now(), old.credentialGeneration],
    );
    expect((await http.list('old-wallet')).status).toBe(204);
    expect((await http.register(rotated, 'new-wallet')).status).toBe(201);
    expect(await (await http.list('new-wallet')).json()).toMatchObject({
      serialNumbers: [rotated.serial],
    });
    await updatePass(
      jobCtxOf(kit),
      { type: 'system', id: null },
      rotated.id,
      { input: { memberName: 'Next Holder' } },
      { scope: null },
    );
    const fresh = await getPass(kit.env.DB, rotated.id);
    if (!fresh) throw new Error('Missing updated pass');
    const response = await http.latest(fresh);
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const passJson = z
      .object({ serialNumber: z.string(), authenticationToken: z.string() })
      .passthrough()
      .parse(JSON.parse(new TextDecoder().decode(files['pass.json'])));
    expect(passJson.serialNumber).toBe(fresh.serial);
    expect(passJson.authenticationToken).toBe(fresh.authToken);
    expect(
      (await http.latest(fresh, kit.env, { 'if-none-match': `"${fresh.objectSha256}"` })).status,
    ).toBe(304);
    expect((await http.register(fresh, 'new-wallet', kit.env, push('b'))).status).toBe(200);
    expect(
      await first(
        kit.env.DB,
        'SELECT push_token FROM registrations WHERE device_id = ? AND pass_id = ?',
        ['new-wallet', fresh.id],
      ),
    ).toEqual({ push_token: push('b') });
    expect(JSON.stringify(passJson)).toContain('Next Holder');
    expect((await http.latest(old)).status).toBe(401);
    expect((await http.list('old-wallet')).status).toBe(204);
    expect(await (await http.list('new-wallet')).json()).toMatchObject({
      serialNumbers: [fresh.serial],
    });

    expect((await http.register(fresh, 'old-wallet')).status).toBe(201);
    expect(await (await http.list('old-wallet')).json()).toMatchObject({
      serialNumbers: [fresh.serial],
    });
    expect((await http.remove(old, 'old-wallet')).status).toBe(401);
    expect(await (await http.list('old-wallet')).json()).toMatchObject({
      serialNumbers: [fresh.serial],
    });
  }, 120_000);

  it('does not attribute a new holder fetch to an old holder check-in', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const old = await kit.pass();
    const http = client(kit);
    expect((await http.register(old, 'old-check-in')).status).toBe(201);
    expect((await http.list('old-check-in')).status).toBe(200);
    expect(
      await pendingAppleFetchDevice(kit.env.DB, old.id, old.serial, old.credentialGeneration, 0),
    ).toEqual([await hashDevice('old-check-in')]);
    expect((await beginTransfer(kit, old)).state).toBe('completed');
    const fresh = await getPass(kit.env.DB, old.id);
    if (!fresh) throw new Error('Missing transferred pass');
    expect(
      await pendingAppleFetchDevice(
        kit.env.DB,
        old.id,
        fresh.serial,
        fresh.credentialGeneration,
        0,
      ),
    ).toEqual([]);
  }, 120_000);

  it('rejects an old registration paused until after a complete credential rotation', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const old = await kit.pass();
    const http = client(kit);
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /INSERT INTO registrations/i,
        when: 'before',
      },
      async () => {
        expect((await beginTransfer(kit, old)).state).toBe('completed');
      },
    );
    const response = await http.register(old, 'race-completed', {
      ...kit.env,
      DB: gate.db,
    } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(401);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [old.id]),
    ).toBeNull();
    const fresh = await getPass(kit.env.DB, old.id);
    if (!fresh) throw new Error('Missing transferred pass');
    expect((await http.register(fresh, 'race-completed')).status).toBe(201);
  }, 120_000);
});
