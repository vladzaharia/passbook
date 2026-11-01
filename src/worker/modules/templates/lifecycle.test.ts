import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  TemplateDetailSchema,
  TemplateListSchema,
  TemplateReissueResponseSchema,
  UploadListSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { createTemplateRegistry } from './registry.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets, importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const workflows: { id: string; params: unknown }[] = [];
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let org: { id: string };
let admin: Record<string, string>;

const call = (path: string, init: RequestInit = {}) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...admin, ...init.headers } },
    env,
  );
const post = (path: string) =>
  call(path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});
const importVersion = (name: string, extra: Record<string, Uint8Array> = {}) =>
  importZip(env, clock, {
    orgId: org.id,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra })),
    name,
  });
const detailOf = async (id: string) =>
  TemplateDetailSchema.parse(await (await call(`/${id}`)).json());

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  const assets = fakeAssets();
  for (const t of generatedSource.templates)
    for (const a of t.assets) assets.files.set(a.source.path, new Uint8Array([1, 2, 3]));
  env = await makeEnv({
    ASSETS: assets,
    BULK_REISSUE: {
      create: async (o: { id: string; params: unknown }) => {
        workflows.push(o);
        return { id: o.id };
      },
    } as unknown as Workflow,
    TEMPLATE_IMPORT: { create: async (o: { id: string }) => ({ id: o.id }) } as unknown as Workflow,
  });
  f = fixtures(env, clock);
  app = createApp({ stores: auth.stores });
  org = await makeOrg(f);
  admin = auth.session({ userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
});

describe('versions and reissue', () => {
  it('counts passes per version and moves the older ones to the active version', async () => {
    const v1 = await importVersion('Counted Card');
    const id = v1.result?.templateId ?? '';
    const t1 = await createTemplateRegistry(env).resolve(id);
    for (let i = 0; i < 3; i++) await makePass(f, { orgId: org.id, template: t1 });
    await importVersion('Counted Card', { 'logo.png': makePng(100, 40) });
    const d = await detailOf(id);
    const old = d.versions.find((v) => v.version === t1.version);
    const active = d.versions.find((v) => v.active);
    expect(old?.passCount).toBe(3);
    expect(active?.passCount).toBe(0);
    expect(d.passesOnOlderVersions).toBe(3);
    expect(d.passCount).toBe(3);

    const res = await post(`/${id}/reissue`);
    expect(res.status).toBe(202);
    expect(TemplateReissueResponseSchema.parse(await res.json())).toMatchObject({ passes: 3 });
    expect(workflows.at(-1)?.params).toMatchObject({
      templateId: id,
      version: d.activeVersion,
      cause: 'template_upgrade',
    });
    expect(
      await first(
        env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'template.reissue' AND target_id = ?",
        [id],
      ),
    ).not.toBeNull();
  });

  it('refuses a reissue when every pass is current', async () => {
    const t = await importVersion('Fresh Card');
    expect((await post(`/${t.result?.templateId}/reissue`)).status).toBe(409);
  });
});

describe('archive and restore', () => {
  it('archives, restores and audits both; built-in templates refuse', async () => {
    const t = await importVersion('Season Pass');
    const id = t.result?.templateId ?? '';
    const archived = TemplateDetailSchema.parse(await (await post(`/${id}/archive`)).json());
    expect(archived.status).toBe('archived');
    const restored = TemplateDetailSchema.parse(await (await post(`/${id}/restore`)).json());
    expect(restored.status).toBe('active');
    expect(
      await first(
        env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'template.restore' AND target_id = ?",
        [id],
      ),
    ).not.toBeNull();
    expect((await post('/baked:starter-generic/archive')).status).toBe(403);
  });
});

describe('search, uploads and packages', () => {
  it('searches names and slugs', async () => {
    await importVersion('Harbor Crew Badge');
    const items = async (q: string) =>
      TemplateListSchema.parse(await (await call(`?q=${encodeURIComponent(q)}`)).json()).items;
    expect((await items('crew')).map((t) => t.name)).toEqual(['Harbor Crew Badge']);
    expect((await items('harbor-crew')).map((t) => t.name)).toEqual(['Harbor Crew Badge']);
    expect(await items('zzz-nothing')).toEqual([]);
  });

  it('lists the newest imports', async () => {
    const res = await call('/uploads?limit=2');
    expect(res.status).toBe(200);
    const list = UploadListSchema.parse(await res.json());
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.createdAt).toBeGreaterThanOrEqual(list.items[1]?.createdAt ?? 0);
  });

  it('downloads a built-in template as an uploadable zip', async () => {
    const res = await call('/baked:starter-generic/package');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('starter-generic.zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['pass.json', 'wallet.template.json']),
    );
    const m = JSON.parse(new TextDecoder().decode(files['wallet.template.json'])) as object;
    expect(m).not.toHaveProperty('org');
  });
});
