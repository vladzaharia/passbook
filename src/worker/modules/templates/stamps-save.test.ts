/// <reference types="vite/client" />

import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { renderStampFiles } from '../../../passkit/stamps/package.ts';
import {
  SaveVersionResponseSchema,
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { crc32, sha1Hex } from './package/hash.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets } from './testing.ts';

const SLUG = 'starter-stamp-card';
const stamp = generatedSource.templates.find((t) => t.slug === SLUG);
if (!stamp) throw new Error('The Stamp card is missing; run npm run gen.');

let env: AppEnv;
let call: (path: string, init?: { body?: unknown; method?: string }) => Promise<Response>;

beforeAll(async () => {
  const clock = new ManualClock();
  const assets = fakeAssets();
  const files = import.meta.glob<string>(
    '../../../../templates/starter-stamp-card/**/*.{png,strings}',
    {
      eager: true,
      query: '?url&inline',
      import: 'default',
    },
  );
  const source = (name: string) => {
    const data = files[`../../../../templates/${SLUG}/${name}`];
    if (!data?.includes(';base64,')) throw new Error(`Missing source ${name}`);
    return Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  };
  // The strips npm run gen drew in Node, drawn again here in workerd: the bytes must agree.
  const block = stamp.manifest.stamps;
  if (!block) throw new Error('The Stamp card has no stamps block.');
  const names = [...Object.values(block.art), 'strip@2x.png', 'strip@3x.png'];
  const drawn = renderStampFiles(block, new Map(names.map((n) => [n, source(n)])));
  const strips = new Map(drawn.strips.map((s) => [s.name, s.bytes]));
  for (const a of stamp.assets) {
    const bytes = strips.get(a.name) ?? source(a.name);
    if (bytes.length !== a.size || (await sha1Hex(bytes)) !== a.sha1 || crc32(bytes) !== a.crc32)
      throw new Error(`${a.name} differs from the generated metadata.`);
    assets.files.set(a.source.path, bytes);
  }
  env = await makeEnv({ ASSETS: assets });
  const f = fixtures(env, clock);
  const app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(env, clock) },
    clock,
  });
  const org = await makeOrg(f);
  const adminId = (await makeUser(f)).id;
  const invitationId = f.ids.id();
  const roles = JSON.stringify(['org_admin']);
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, org.id, roles, f.ids.token(), now, now + 3600_000, now, adminId],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), org.id, adminId, invitationId, roles, now],
  );
  const admin = (await makeSession(f, { userId: adminId, roles: ['user'] })).headers;
  call = async (path, init = {}) =>
    app.request(
      `https://wallet.test/api/v1/templates${path}`,
      {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: { ...admin, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      env,
    );
  const clone = await call(`/baked:${SLUG}/clone`, { body: { orgId: org.id, name: 'Coffee' } });
  if (clone.status !== 201) throw new Error(`Clone failed: ${clone.status}`);
  cloneId = TemplateDetailSchema.parse(await clone.json()).id;
});

let cloneId = '';
type Version = ReturnType<typeof TemplateVersionDetailSchema.parse>;
const version = async (v: string): Promise<Version> =>
  TemplateVersionDetailSchema.parse(await (await call(`/${cloneId}/versions/${v}`)).json());
const latest = async () => {
  const detail = TemplateDetailSchema.parse(await (await call(`/${cloneId}`)).json());
  return version(detail.versions[0]?.version ?? '');
};
const manifestOf = (v: Version) => v.manifest as Record<string, unknown>;
const strips = (v: Version) => v.assets.filter((a) => a.name.startsWith('stamps/strips/'));
/** The designer's body: generated strips are never sent back. */
const draft = (v: Version, manifest = v.manifest, passJson = v.passJson) => ({
  passJson,
  manifest,
  assets: v.assets
    .filter((a) => !a.name.startsWith('stamps/strips/'))
    .map(({ name, sha1 }) => ({ name, sha1 })),
});
const save = async (body: unknown) =>
  SaveVersionResponseSchema.parse(await (await call(`/${cloneId}/versions`, { body })).json());
const header = (passJson: unknown) =>
  (passJson as { storeCard: { headerFields: { key: string; value: string }[] } }).storeCard
    .headerFields[0]?.value;
const withGoal = (v: Version, goal: number) => {
  const m = structuredClone(v.manifest) as Record<string, any>;
  m.stamps.goal = goal;
  m.inputs.properties.stamps.maximum = 2 * goal - 1;
  // Redeeming at the scanner takes the goal.
  for (const a of m.scan?.actions ?? []) if (a.kind === 'take') a.amount = goal;
  return m;
};

describe('a Stamp card in the designer', () => {
  it('clones with every strip and the art kept as source', async () => {
    const v = await latest();
    expect(strips(v)).toHaveLength(22);
    expect(v.assets.filter((a) => a.slot === 'source').map((a) => a.name)).toEqual([
      'stamps/empty.png',
      'stamps/filled.png',
      'stamps/reward-earned.png',
      'stamps/reward.png',
    ]);
  });

  it('dry-runs the sample from carried strips, under the same version', async () => {
    const v = await latest();
    const res = await save({ ...draft(v), dryRun: true });
    expect(res.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(res).toMatchObject({ saved: false, created: false, version: v.version });
    expect(header(res.passJson)).toBe('7 of 10');
    const sample = { ...(manifestOf(v).sample as object), stamps: 12 };
    const ready = await save({ ...draft(v, { ...manifestOf(v), sample }), dryRun: true });
    expect(header(ready.passJson)).toBe('Reward ready');
  });

  it('draws a new goal on save, and carries the strips when only the copy changes', async () => {
    const v = await latest();
    const dry = await save({ ...draft(v, withGoal(v, 8)), dryRun: true });
    expect(dry).toMatchObject({ saved: false, created: true });
    expect(header(dry.passJson)).toBe('7 of 8');
    const eight = await save(draft(v, withGoal(v, 8)));
    expect(eight).toMatchObject({ saved: true, created: true });
    const saved = await version(eight.version ?? '');
    expect(strips(saved)).toHaveLength(18);
    const renamed = { ...saved.passJson, description: 'Coffee stamps' };
    const again = await save(draft(saved, saved.manifest, renamed));
    const next = await version(again.version ?? '');
    expect(next.version).not.toBe(saved.version);
    expect(strips(next)).toEqual(strips(saved));
  });

  it('serves the strip for a count, and leaves strips out of the package', async () => {
    // Versions saved in the same tick have no stable order: pick the goal-8 version by its goal.
    const detail = TemplateDetailSchema.parse(await (await call(`/${cloneId}`)).json());
    const all = await Promise.all(detail.versions.map((x) => version(x.version)));
    const v = all.find((x) => (manifestOf(x).stamps as { goal: number }).goal === 8);
    if (!v) throw new Error('no goal-8 version');
    const bytes = async (path: string) =>
      sha1Hex(new Uint8Array(await (await call(path)).arrayBuffer()));
    const at = (name: string) => v.assets.find((a) => a.name === name)?.sha1;
    const base = `/${cloneId}/versions/${v.version}/assets`;
    expect(await bytes(`${base}/strip@2x.png?stamps=3`)).toBe(at('stamps/strips/3/strip@2x.png'));
    expect(await bytes(`${base}/strip@3x.png?stamps=9`)).toBe(at('stamps/strips/8/strip@3x.png'));
    expect(await bytes(`${base}/strip@2x.png`)).toBe(at('strip@2x.png'));
    const zip = unzipSync(new Uint8Array(await (await call(`/${cloneId}/package`)).arrayBuffer()));
    expect(Object.keys(zip)).toContain('stamps/filled.png');
    expect(Object.keys(zip).filter((n) => n.startsWith('stamps/strips/'))).toEqual([]);
  });

  it('points a preview at the strip for its count', async () => {
    const v = await latest();
    const input = { ...(manifestOf(v).sample as object), stamps: 5 };
    const res = await call(`/${cloneId}/preview`, { body: { input } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetBaseUrl: string; assetNames: string[] };
    expect(new URL(body.assetBaseUrl).searchParams.get('stamps')).toBe('5');
    expect(body.assetNames).toContain('strip@2x.png');
    expect(body.assetNames.some((n) => n.startsWith('stamps/'))).toBe(false);
  });

  it('keeps the manifest editor off the stamps block', async () => {
    const v = await latest();
    const put = (manifest: unknown) =>
      call(`/${cloneId}/manifest`, { method: 'PUT', body: { manifest } });
    const res = await put(withGoal(v, 6));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STAMPS_REDRAW' });
    expect((await put({ ...manifestOf(v), description: 'Edited' })).status).toBe(200);
  });
});
