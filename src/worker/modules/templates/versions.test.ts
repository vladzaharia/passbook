import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { PREVIEW_SCAN_CODE } from './build-check.ts';
import { basicPackage, makePng, passJson, zipOf } from './package/fixtures.ts';
import { importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let orgId: string;
let otherOrgId: string;
let mine: { id: string; version: string; assets: { name: string; sha1: string }[] };
let theirs: { id: string; assets: { name: string; sha1: string }[] };
let admin: Record<string, string>;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const manifest = (name = 'Designer Card') => ({
  schema: 1,
  name,
  inputs: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', 'x-label': 'Name' } },
  },
  sample: { name: 'Alex' },
  bindings: [
    { to: { field: 'name' }, value: '{{name}}' },
    { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
  ],
  display: { title: '{{name}}' },
});
const pass = (extra: Record<string, unknown> = {}) =>
  passJson({
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
    ...extra,
  });

const call = (path: string, init: RequestInit = {}, headers = admin) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...headers, ...init.headers } },
    env,
  );
const save = (id: string, body: Record<string, unknown>, headers = admin) =>
  call(
    `/${id}/versions`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    headers,
  );
const same = (assets: { name: string; sha1: string }[]) =>
  assets.map(({ name, sha1 }) => ({ name, sha1 }));
const draft = (over: Record<string, unknown> = {}) => ({
  passJson: pass(),
  manifest: manifest(),
  assets: same(mine.assets),
  ...over,
});
const versionCount = async (id: string) =>
  (
    await first<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM template_versions WHERE template_id = ?',
      [id],
    )
  )?.n;

async function seed(org: string, name: string, extra: Record<string, Uint8Array> = {}) {
  const r = await importZip(env, clock, {
    orgId: org,
    zip: zipOf(
      basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra }, pass()),
    ),
    name,
  });
  const id = r.result?.templateId ?? '';
  const res = await call(`/${id}`);
  const body = (await res.json()) as {
    versions: { version: string; assets: { name: string; sha1: string }[] }[];
  };
  return { id, version: r.result?.version ?? '', assets: body.versions[0]?.assets ?? [] };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  env = await makeEnv();
  f = fixtures(env, clock);
  app = createApp({ stores: auth.stores });
  orgId = (await makeOrg(f)).id;
  otherOrgId = (await makeOrg(f)).id;
  admin = auth.session({ userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
  mine = await seed(orgId, 'Designer Card');
  theirs = await seed(otherOrgId, 'Other Card', { 'logo@2x.png': makePng(120, 40) });
});

describe('POST /templates/{id}/versions', () => {
  it('dry run returns the report and the built pass, and stores nothing', async () => {
    const before = await versionCount(mine.id);
    const res = await save(mine.id, draft({ dryRun: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      saved: boolean;
      report: { ok: boolean };
      passJson: { barcodes: { message: string }[] };
    };
    expect(body.saved).toBe(false);
    expect(body.report.ok).toBe(true);
    expect(body.passJson.barcodes[0]?.message).toBe(PREVIEW_SCAN_CODE);
    expect(await versionCount(mine.id)).toBe(before);
  });

  it('saves a new version without activating it, then activates on request', async () => {
    const changed = draft({
      passJson: pass({
        generic: { primaryFields: [{ key: 'name', label: 'Member', value: 'x' }] },
      }),
    });
    const saved = await save(mine.id, changed);
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      saved: boolean;
      created: boolean;
      activated: boolean;
      version: string;
      template: { activeVersion: string; versions: unknown[] };
    };
    expect(body).toMatchObject({ saved: true, created: true, activated: false });
    expect(body.template.activeVersion).toBe(mine.version);
    expect(body.template.versions).toHaveLength(2);

    const again = await save(mine.id, { ...changed, activate: true });
    const next = (await again.json()) as {
      created: boolean;
      activated: boolean;
      template: { activeVersion: string };
    };
    expect(next).toMatchObject({ created: false, activated: true });
    expect(next.template.activeVersion).toBe(body.version);
  });

  it('keeps manifest.messaging on save and refuses one that no back field backs', async () => {
    const withMessage = (changeMessage?: string) =>
      draft({
        manifest: { ...manifest('Messaging Card'), messaging: { input: 'name' } },
        passJson: pass({
          generic: {
            primaryFields: [{ key: 'other', label: 'Other', value: 'x' }],
            backFields: [
              {
                key: 'name',
                label: 'Message',
                value: '',
                ...(changeMessage ? { changeMessage } : {}),
              },
            ],
          },
        }),
      });
    const bad = await save(mine.id, withMessage());
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('MESSAGING_FIELD');
    const ok = await save(mine.id, withMessage('%@'));
    expect(ok.status).toBe(200);
    const { version } = (await ok.json()) as { version: string };
    const row = await first<{ manifest: string }>(
      env.DB,
      'SELECT manifest FROM template_versions WHERE template_id = ? AND version = ?',
      [mine.id, version],
    );
    expect(JSON.parse(row?.manifest ?? '{}').messaging).toEqual({ input: 'name' });
  });

  it('keeps carried files and stores uploaded images', async () => {
    const icon3 = b64(makePng(114, 114));
    const res = await save(mine.id, {
      ...draft(),
      assets: [
        ...same(mine.assets).filter((a) => a.name !== 'icon@2x.png'),
        { name: 'icon@3x.png', upload: icon3 },
      ],
      dryRun: true,
    });
    const body = (await res.json()) as { report: { ok: boolean }; assets: { name: string }[] };
    expect(body.report.ok).toBe(true);
    expect(body.assets.map((a) => a.name)).toContain('icon@3x.png');
  });

  it('refuses built-in templates', async () => {
    const res = await save('baked:starter-generic', draft());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_BAKED' });
  });

  it('rejects invalid images with the report in the problem', async () => {
    const notPng = await save(mine.id, {
      ...draft(),
      assets: [...same(mine.assets), { name: 'logo.png', upload: b64(new Uint8Array([1, 2, 3])) }],
    });
    expect(notPng.status).toBe(422);
    expect(JSON.stringify(await notPng.json())).toContain('IMAGE_INVALID');
    const wrongSize = await save(mine.id, {
      ...draft(),
      assets: [
        ...same(mine.assets).filter((a) => a.name !== 'icon.png'),
        { name: 'icon.png', upload: b64(makePng(500, 500)) },
      ],
    });
    expect(wrongSize.status).toBe(422);
    expect(JSON.stringify(await wrongSize.json())).toContain('IMAGE_SIZE');
    const dry = await save(mine.id, {
      ...draft(),
      dryRun: true,
      assets: [{ name: 'logo.png', upload: b64(new Uint8Array([1, 2, 3])) }],
    });
    const body = (await dry.json()) as {
      saved: boolean;
      report: { ok: boolean; issues: { code: string }[] };
    };
    expect(body.saved).toBe(false);
    expect(body.report.ok).toBe(false);
    expect(body.report.issues.map((i) => i.code)).toContain('IMAGE_INVALID');
  });

  it('rejects an invalid manifest and a missing icon', async () => {
    const bad = await save(
      mine.id,
      draft({ manifest: { ...manifest(), inputs: { type: 'array' } } }),
    );
    expect(bad.status).toBe(422);
    const noIcon = await save(mine.id, { ...draft(), assets: [] });
    expect(noIcon.status).toBe(422);
    expect(JSON.stringify(await noIcon.json())).toContain('MISSING_ICON');
  });

  it('never reads another template’s files, even with their hash', async () => {
    const before = await versionCount(mine.id);
    const res = await save(mine.id, {
      ...draft(),
      assets: [
        ...same(mine.assets),
        ...same(theirs.assets).filter((a) => a.name === 'logo@2x.png'),
      ],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('ASSET_UNKNOWN');
    expect(await versionCount(mine.id)).toBe(before);
    expect(await versionCount(theirs.id)).toBe(1);
  });

  it('is admin only and finds only real templates', async () => {
    for (const headers of [
      {},
      auth.user(),
      auth.apiKey({ orgId, scopes: ['templates:read'] }),
      auth.apiKey({ scopes: ['templates:read', 'passes:write'] }),
    ]) {
      expect([401, 403]).toContain((await save(mine.id, draft(), headers)).status);
    }
    expect((await save('missing', draft())).status).toBe(404);
    const { 'x-csrf-token': _drop, ...noCsrf } = admin;
    expect((await save(mine.id, draft(), noCsrf)).status).toBe(403);
  });

  it('answers the same in test mode', async () => {
    const res = await save(mine.id, draft({ dryRun: true }), auth.admin({ mode: 'test' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: { ok: boolean } }).report.ok).toBe(true);
  });

  it('refuses an archived template', async () => {
    const t = await seed(orgId, 'Old Card');
    await call(`/${t.id}/archive`, { method: 'POST' });
    const res = await save(t.id, { ...draft(), assets: same(t.assets) });
    expect(res.status).toBe(409);
  });
});
