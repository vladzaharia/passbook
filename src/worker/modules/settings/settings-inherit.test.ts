import { env } from 'cloudflare:workers';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { clearSettingsCache } from './service.ts';

type Entry = {
  key: string;
  value: unknown;
  default?: unknown;
  source: 'org' | 'default';
  ceiling?: number;
  blockedByPlatform?: boolean;
  blockedByPlan?: boolean;
  planBlocked?: string[];
};
let appEnv: AppEnv;
let fx: Fixtures;
let admin: SessionFixture;
let member: SessionFixture;
let app: OpenAPIHono<AppBindings>;

const call = (method: string, path: string, body?: unknown, headers = admin.headers) =>
  app.request(
    `/api/v1/settings${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    appEnv,
  );

async function orgScope(): Promise<string> {
  const org = await makeOrg(fx);
  const now = fx.clock.now();
  const invitation = fx.ids.id();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitation, org.id, '["org_admin"]', fx.ids.token(), now, now + 3600_000, now, member.userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fx.ids.id(), org.id, member.userId, invitation, '["org_admin"]', now],
  );
  return `org:${org.id}`;
}

const read = async (scope: string, headers = member.headers) => {
  const res = await call('GET', `?scope=${encodeURIComponent(scope)}`, undefined, headers);
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: Entry[] };
  return (key: string) => items.find((i) => i.key === key) as Entry;
};
const put = (scope: string, values: Record<string, unknown>) =>
  call('PUT', '', { scope, values }, member.headers);

beforeAll(async () => {
  appEnv = await makeEnv({ RL_API_KEY: fakeRateLimiter({ limit: 1000 }) });
});
beforeEach(async () => {
  await run(env.DB, 'DELETE FROM settings');
  await run(env.DB, 'DELETE FROM audit_log');
  clearSettingsCache(env.DB);
  fx = fixtures(appEnv);
  admin = await makeSession(fx, { userId: (await makeUser(fx)).id, roles: ['admin', 'user'] });
  member = await makeSession(fx, { userId: (await makeUser(fx)).id });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(appEnv, fx.clock),
      apiKeys: createApiKeyStore(appEnv, fx.clock),
    },
    clock: fx.clock,
  });
});

describe('settings source and ceiling', () => {
  it('marks unset org values as default and the platform default as the effective value', async () => {
    const scope = await orgScope();
    expect((await call('PUT', '', { values: { 'retention.scansDays': 200 } })).status).toBe(200);
    const entry = (await read(scope))('retention.scansDays');
    expect(entry).toMatchObject({ source: 'default', value: 200, default: 200, ceiling: 1095 });
  });

  it('marks a stored org value as org, and resets it with null', async () => {
    const scope = await orgScope();
    expect((await put(scope, { 'retention.scansDays': 100 })).status).toBe(200);
    expect(await read(scope).then((get) => get('retention.scansDays'))).toMatchObject({
      source: 'org',
      value: 100,
    });
    expect((await put(scope, { 'retention.scansDays': null })).status).toBe(200);
    expect(await read(scope).then((get) => get('retention.scansDays'))).toMatchObject({
      source: 'default',
      value: 396,
    });
  });

  it('clamps stored org values to the platform ceiling, and shows the ceiling', async () => {
    const scope = await orgScope();
    expect((await put(scope, { 'email.orgCapPerDay': 400 })).status).toBe(200);
    expect((await call('PUT', '', { values: { 'email.orgCapPerDayMax': 100 } })).status).toBe(200);
    const entry = (await read(scope))('email.orgCapPerDay');
    expect(entry).toMatchObject({ source: 'org', value: 100, ceiling: 100, default: 100 });
  });

  it('clamps an unset email cap default to a lowered ceiling', async () => {
    const scope = await orgScope();
    await call('PUT', '', { values: { 'email.orgCapPerDayMax': 50 } });
    expect((await read(scope))('email.orgCapPerDay')).toMatchObject({
      source: 'default',
      value: 50,
      ceiling: 50,
    });
  });

  it('refuses an org retention value above the platform maximum', async () => {
    const scope = await orgScope();
    await call('PUT', '', { values: { 'retention.scansMaxDays': 1000 } });
    expect((await put(scope, { 'retention.scansDays': 1001 })).status).toBe(422);
  });

  it('flags the org NFC tag switch only while the platform tag switch is off, not Apple NFC', async () => {
    const scope = await orgScope();
    expect((await read(scope))('nfc.tags').blockedByPlatform).toBeUndefined();
    await call('PUT', '', { values: { 'nfc.tagsEnabled': false } });
    expect((await read(scope))('nfc.tags').blockedByPlatform).toBe(true);
    await call('PUT', '', { values: { 'nfc.tagsEnabled': true } });
    expect((await read(scope))('nfc.tags').blockedByPlatform).toBeUndefined();
  });

  it('reports platform entries as org when stored and default when not', async () => {
    await call('PUT', '', { values: { 'scan.lookupsPerHour': 300 } });
    const get = await read('platform', admin.headers);
    expect(get('scan.lookupsPerHour')).toMatchObject({ source: 'org', value: 300 });
    expect(get('scan.undoWindowMinutes')).toMatchObject({ source: 'default', value: 10 });
    expect(get('scan.undoWindowMinutes').ceiling).toBeUndefined();
  });

  it('allows org NFC tags with Apple NFC off; refuses enabling them while the platform tag switch is off', async () => {
    const scope = await orgScope();
    expect((await put(scope, { 'nfc.tags': { enabled: true } })).status).toBe(200);
    expect((await put(scope, { 'nfc.tags': { enabled: false } })).status).toBe(200);
    await call('PUT', '', { values: { 'nfc.tagsEnabled': false } });
    const res = await put(scope, { 'nfc.tags': { enabled: true } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('NFC_OFF');
    await call('PUT', '', { values: { 'nfc.tagsEnabled': true } });
    expect((await put(scope, { 'nfc.tags': { enabled: true } })).status).toBe(200);
  });

  it('refuses an org email cap above the platform maximum on write', async () => {
    const scope = await orgScope();
    await call('PUT', '', { values: { 'email.orgCapPerDayMax': 100 } });
    const res = await put(scope, { 'email.orgCapPerDay': 101 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('Up to 100.');
    expect((await read(scope))('email.orgCapPerDay')).toMatchObject({ source: 'default' });
    expect((await put(scope, { 'email.orgCapPerDay': 100 })).status).toBe(200);
  });

  it('refuses an org principal reading platform scope, new fields included', async () => {
    await orgScope();
    const res = await call('GET', '?scope=platform', undefined, member.headers);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('retention.scansMaxDays');
  });
});

describe('settings and the plan', () => {
  const plan = (scope: string, preset: string) =>
    run(env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [
      preset,
      scope.slice(4),
    ]);

  it('leaves a legacy org as it was: nfc.tags is not blocked and can be turned on', async () => {
    const scope = await orgScope();
    expect((await read(scope))('nfc.tags').blockedByPlan).toBeUndefined();
    expect((await put(scope, { 'nfc.tags': { enabled: true } })).status).toBe(200);
  });

  it('flags nfc.tags blockedByPlan while the plan has nfc off, apart from the platform flag', async () => {
    const scope = await orgScope();
    await plan(scope, 'trial');
    expect((await read(scope))('nfc.tags')).toMatchObject({ blockedByPlan: true });
    expect((await read(scope))('nfc.tags').blockedByPlatform).toBeUndefined();
    await call('PUT', '', { values: { 'nfc.tagsEnabled': false } });
    expect((await read(scope))('nfc.tags')).toMatchObject({
      blockedByPlan: true,
      blockedByPlatform: true,
    });
    await plan(scope, 'standard');
    expect((await read(scope))('nfc.tags').blockedByPlan).toBeUndefined();
  });

  it('lists the channels the plan lacks on channels.blocked, and nothing for legacy', async () => {
    const scope = await orgScope();
    expect((await read(scope))('channels.blocked').planBlocked).toBeUndefined();
    await plan(scope, 'trial');
    expect((await read(scope))('channels.blocked').planBlocked).toEqual([
      'samsung',
      'paper',
      'nfc',
    ]);
    await plan(scope, 'standard');
    expect((await read(scope))('channels.blocked').planBlocked).toBeUndefined();
  });

  it('refuses turning nfc.tags on with FEATURE_NOT_INCLUDED, writes nothing, and allows turning it off', async () => {
    const scope = await orgScope();
    await plan(scope, 'trial');
    const res = await put(scope, { 'nfc.tags': { enabled: true } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'nfc' });
    expect((await read(scope))('nfc.tags')).toMatchObject({ source: 'default' });
    expect((await put(scope, { 'nfc.tags': { enabled: false } })).status).toBe(200);
    expect((await put(scope, { 'email.orgCapPerDay': 30 })).status).toBe(200);
  });

  it('refuses a reset of nfc.tags while the plan lacks nfc: the default is on (L1)', async () => {
    const scope = await orgScope();
    expect((await put(scope, { 'nfc.tags': { enabled: false } })).status).toBe(200);
    await plan(scope, 'trial');
    const res = await put(scope, { 'nfc.tags': null });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'nfc' });
    expect((await read(scope))('nfc.tags')).toMatchObject({
      source: 'org',
      value: { enabled: false },
    });
    await plan(scope, 'standard');
    expect((await put(scope, { 'nfc.tags': null })).status).toBe(200);
  });

  it('allows the write again once the plan includes nfc', async () => {
    const scope = await orgScope();
    await plan(scope, 'trial');
    expect((await put(scope, { 'nfc.tags': { enabled: true } })).status).toBe(403);
    await plan(scope, 'standard');
    expect((await put(scope, { 'nfc.tags': { enabled: true } })).status).toBe(200);
  });
});
