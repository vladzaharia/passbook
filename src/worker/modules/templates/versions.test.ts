import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { behaviors, PREVIEW_SCAN_CODE } from './build-check.ts';
import { analyzePackage } from './package/analyze.ts';
import { basicPackage, makePng, passJson } from './package/fixtures.ts';
import { buildKey } from './package/hash.ts';
import { slugify } from './persist.ts';
import { createTemplateRegistry, r2Key } from './registry.ts';
import { countStalePasses } from './repo-stale.ts';
import { syncBakedTemplates } from './sync.ts';

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

async function addMembership(userId: string, org: string, roles: OrgRole[]) {
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, org, JSON.stringify(roles), f.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, org, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

async function member(org: string, roles: OrgRole[]) {
  const person = await makeUser(f);
  const membershipId = await addMembership(person.id, org, roles);
  const session = await makeSession(f, { userId: person.id });
  return {
    membershipId,
    sessionId: await sha256Hex(session.cookieValue),
    headers: session.headers,
  };
}

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
  // Existing published rows are seeded independently of the draft-only import workflow.
  const analysis = await analyzePackage(
    basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra }, pass()),
    { uploaded: true, fallbackName: name, images: {}, behaviors },
  );
  if (!('version' in analysis) || !analysis.report.ok)
    throw new Error(`Invalid legacy template fixture: ${JSON.stringify(analysis.report)}`);
  const id = f.ids.id();
  const now = clock.now();
  const assets = [];
  for (const asset of analysis.assets) {
    const key = r2Key(org, id, analysis.version, asset.name);
    const bytes = analysis.files.get(asset.name);
    if (!bytes) throw new Error(`Missing legacy asset ${asset.name}`);
    await env.BUCKET.put(key, bytes);
    assets.push({ ...asset, source: { kind: 'r2' as const, key } });
  }
  await run(
    env.DB,
    `INSERT INTO templates
      (id, org_id, slug, name, description, origin, active_version, status, styles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploaded', ?, 'active', ?, ?, ?)`,
    [
      id,
      org,
      slugify(name),
      name,
      analysis.manifest.description ?? null,
      analysis.version,
      JSON.stringify(analysis.styles),
      now,
      now,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      analysis.version,
      await buildKey(analysis),
      JSON.stringify(analysis.manifest),
      JSON.stringify(analysis.passJson),
      JSON.stringify(assets),
      JSON.stringify(analysis.report),
      now,
    ],
  );
  return { id, version: analysis.version, assets: analysis.assets };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  env = await makeEnv();
  f = fixtures(env, clock);
  app = createApp({ stores: { ...auth.stores, sessions: createSessionStore(env, clock) }, clock });
  orgId = (await makeOrg(f)).id;
  otherOrgId = (await makeOrg(f)).id;
  const adminId = (await makeUser(f)).id;
  await addMembership(adminId, orgId, ['org_admin']);
  await addMembership(adminId, otherOrgId, ['org_admin']);
  admin = (await makeSession(f, { userId: adminId, roles: ['admin', 'user'] })).headers;
  mine = await seed(orgId, 'Designer Card');
  theirs = await seed(otherOrgId, 'Other Card', { 'logo@2x.png': makePng(120, 40) });
});

describe('display-only version saves', () => {
  const scan = {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    display: { v: 1, header: { subtitle: 'Before' } },
  };
  const scannedManifest = (name: string) => ({ ...manifest(name), scan });

  it('saves an equivalent display draft without changing issued passes or their artifacts', async () => {
    const name = 'Display Only Card';
    const original = scannedManifest(name);
    const t = await seed(orgId, name, {
      'wallet.template.json': new TextEncoder().encode(JSON.stringify(original)),
    });
    const template = await createTemplateRegistry(env).resolve(t.id, t.version);
    const issued = await makePass(f, { orgId, template });
    const passBefore = await first(
      env.DB,
      'SELECT template_version, version, object_key FROM passes WHERE id = ?',
      [issued.id],
    );
    const passVersionsBefore = await first<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [issued.id],
    );
    const outboxBefore = await first<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?',
      [issued.id],
    );
    const objectsBefore = (await env.BUCKET.list({ prefix: `passes/${issued.id}/` })).objects.map(
      (object) => object.key,
    );
    const edited = {
      ...original,
      scan: { ...scan, display: { v: 1, header: { subtitle: 'After' } } },
    };
    // The first template request in a file publishes the baked templates; do that before counting.
    await syncBakedTemplates(createServiceContext(env));
    const writes = vi.spyOn(env.BUCKET, 'put');
    let res: Response;
    try {
      res = await save(t.id, {
        passJson: pass(),
        manifest: edited,
        assets: same(t.assets),
      });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      displayOnly: boolean;
      template: { activeVersion: string; versions: { version: string; displayOnly: boolean }[] };
    };
    expect(body).toMatchObject({ displayOnly: true });
    expect(body.version).not.toBe(t.version);
    expect(body.template.activeVersion).toBe(t.version);
    expect(body.template.versions.find((v) => v.version === body.version)?.displayOnly).toBe(true);
    const keys = await Promise.all(
      [t.version, body.version].map((version) =>
        first<{ build_key: string | null }>(
          env.DB,
          'SELECT build_key FROM template_versions WHERE template_id = ? AND version = ?',
          [t.id, version],
        ),
      ),
    );
    expect(keys[0]?.build_key).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]?.build_key).toBe(keys[0]?.build_key);
    expect(
      await first(env.DB, 'SELECT template_version, version, object_key FROM passes WHERE id = ?', [
        issued.id,
      ]),
    ).toEqual(passBefore);
    expect(
      await first(env.DB, 'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?', [issued.id]),
    ).toEqual(passVersionsBefore);
    expect(
      await first(env.DB, 'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?', [issued.id]),
    ).toEqual(outboxBefore);
    expect(
      (await env.BUCKET.list({ prefix: `passes/${issued.id}/` })).objects.map(
        (object) => object.key,
      ),
    ).toEqual(objectsBefore);
    expect(await countStalePasses(env.DB, t.id, body.version)).toBe(0);
  });

  it('saves pass and asset changes as drafts and refuses release without approval', async () => {
    const name = 'Display Guard Card';
    const original = scannedManifest(name);
    const t = await seed(orgId, name, {
      'wallet.template.json': new TextEncoder().encode(JSON.stringify(original)),
    });
    const changedDisplay = {
      ...original,
      scan: { ...scan, display: { v: 1, header: { subtitle: 'After' } } },
    };
    const changedPass = pass({
      generic: { primaryFields: [{ key: 'name', label: 'Member', value: 'Alex Morgan' }] },
    });
    const byPass = await save(t.id, {
      passJson: changedPass,
      manifest: changedDisplay,
      assets: same(t.assets),
    });
    expect(byPass.status).toBe(200);
    const passResult = (await byPass.json()) as {
      version: string;
      template: { activeVersion: string };
    };
    expect(passResult).toMatchObject({ saved: true, displayOnly: false });
    expect(passResult.template.activeVersion).toBe(t.version);

    const byAsset = await save(t.id, {
      passJson: pass(),
      manifest: changedDisplay,
      assets: [...same(t.assets), { name: 'icon@3x.png', upload: b64(makePng(114, 114)) }],
    });
    expect(byAsset.status).toBe(200);
    expect(await byAsset.json()).toMatchObject({
      saved: true,
      displayOnly: false,
      template: { activeVersion: t.version },
    });

    const normal = await save(t.id, {
      passJson: changedPass,
      manifest: changedDisplay,
      assets: same(t.assets),
    });
    expect(normal.status).toBe(200);
    expect(
      await first(env.DB, 'SELECT active_version FROM templates WHERE id = ?', [t.id]),
    ).toEqual({
      active_version: t.version,
    });
  });

  it('keeps the legacy NULL key immutable on a display draft', async () => {
    const name = 'Legacy Display Card';
    const original = scannedManifest(name);
    const t = await seed(orgId, name, {
      'wallet.template.json': new TextEncoder().encode(JSON.stringify(original)),
    });
    await env.DB.prepare(
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
       SELECT template_id, 'legacy', manifest, pass_json, assets, report, created_by, created_at
       FROM template_versions WHERE template_id = ? AND version = ?`,
    )
      .bind(t.id, t.version)
      .run();
    await env.DB.prepare("UPDATE templates SET active_version = 'legacy' WHERE id = ?")
      .bind(t.id)
      .run();
    const res = await save(t.id, {
      passJson: pass(),
      manifest: {
        ...original,
        scan: { ...scan, display: { v: 1, header: { subtitle: 'After' } } },
      },
      assets: same(t.assets),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { version: string };
    expect(result).toMatchObject({
      saved: true,
      displayOnly: false,
      template: { activeVersion: 'legacy' },
    });
    expect(
      await first(
        env.DB,
        "SELECT build_key FROM template_versions WHERE template_id = ? AND version = 'legacy'",
        [t.id],
      ),
    ).toEqual({ build_key: null });
  });

  it('does not backfill an existing legacy target with a NULL key', async () => {
    const name = 'Legacy Target Card';
    const original = scannedManifest(name);
    const t = await seed(orgId, name, {
      'wallet.template.json': new TextEncoder().encode(JSON.stringify(original)),
    });
    const edited = {
      ...original,
      scan: { ...scan, display: { v: 1, header: { subtitle: 'After' } } },
    };
    const input = {
      passJson: pass(),
      manifest: edited,
      assets: same(t.assets),
    };
    const dry = await save(t.id, { ...input, dryRun: true });
    const preview = (await dry.json()) as { version: string; report: unknown };
    expect(preview).toMatchObject({ saved: false, displayOnly: true });
    await env.DB.prepare(
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
       SELECT template_id, ?, ?, pass_json, assets, ?, created_by, created_at
       FROM template_versions WHERE template_id = ? AND version = ?`,
    )
      .bind(
        preview.version,
        JSON.stringify(edited),
        JSON.stringify(preview.report),
        t.id,
        t.version,
      )
      .run();
    const res = await save(t.id, input);
    expect(await res.json()).toMatchObject({
      saved: true,
      created: false,
      displayOnly: false,
      template: { activeVersion: t.version },
    });
    expect(
      await first(
        env.DB,
        'SELECT build_key FROM template_versions WHERE template_id = ? AND version = ?',
        [t.id, preview.version],
      ),
    ).toEqual({ build_key: null });
  });
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

  it('saves a new draft and refuses activation until a release is approved', async () => {
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
      version: string;
      template: { activeVersion: string; versions: unknown[] };
    };
    expect(body).toMatchObject({ saved: true, created: true });
    expect(body.template.activeVersion).toBe(mine.version);
    expect(body.template.versions).toHaveLength(2);

    const again = await save(mine.id, changed);
    expect(again.status).toBe(200);
    expect(await versionCount(mine.id)).toBe(2);
    expect(
      await first(env.DB, 'SELECT active_version FROM templates WHERE id = ?', [mine.id]),
    ).toEqual({
      active_version: mine.version,
    });
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

  it('keeps manifest.scan and nfc on save, and an edit to scan is a new version', async () => {
    const scan = { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] };
    const first1 = await save(
      mine.id,
      draft({ manifest: { ...manifest('Scan Card'), scan, nfc: { enabled: false } } }),
    );
    expect(first1.status).toBe(200);
    const { version: v1 } = (await first1.json()) as { version: string };
    const row = await first<{ manifest: string }>(
      env.DB,
      'SELECT manifest FROM template_versions WHERE template_id = ? AND version = ?',
      [mine.id, v1],
    );
    expect(JSON.parse(row?.manifest ?? '{}')).toMatchObject({ scan, nfc: { enabled: false } });
    const edited = { actions: [{ ...scan.actions[0], label: 'Let in' }] };
    const second = await save(
      mine.id,
      draft({ manifest: { ...manifest('Scan Card'), scan: edited, nfc: { enabled: false } } }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { version: string }).version).not.toBe(v1);
    const bad = await save(
      mine.id,
      draft({ manifest: { ...manifest('Scan Card'), scan: { ...scan, values: [] } } }),
    );
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('SCAN_SHAPE');
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

  it('rejects anonymous requests, API keys, and sessions without membership', async () => {
    const noMembership = (await makeSession(f, { userId: (await makeUser(f)).id })).headers;
    for (const headers of [
      {},
      auth.apiKey({ orgId, scopes: ['templates:read'] }),
      auth.apiKey({ scopes: ['templates:read', 'passes:write'] }),
    ]) {
      expect((await save(mine.id, draft(), headers)).status).toBe(401);
      expect((await save(mine.id, draft({ activate: 'display-only' }), headers)).status).toBe(401);
    }
    expect((await save(mine.id, draft(), noMembership)).status).toBe(404);
    expect((await save('missing', draft())).status).toBe(404);
    const { 'x-csrf-token': _drop, ...noCsrf } = admin;
    expect((await save(mine.id, draft(), noCsrf)).status).toBe(403);
  });

  it('separates authoring from publish capability, and masks another tenant', async () => {
    const t = await seed(orgId, 'Capability Draft');
    const author = await member(orgId, ['template_author']);
    const publisher = await member(orgId, ['template_publisher']);
    const reader = await member(orgId, ['read_only']);
    const foreign = await member(otherOrgId, ['template_author', 'template_publisher']);
    const body = draft({ assets: same(t.assets), manifest: manifest('Capability Draft Changed') });
    expect((await save(t.id, body, reader.headers)).status).toBe(403);
    expect((await save(t.id, body, publisher.headers)).status).toBe(403);
    expect((await save(t.id, body, foreign.headers)).status).toBe(404);
    expect((await save(t.id, { ...body, dryRun: true }, author.headers)).status).toBe(200);
    const saved = await save(t.id, body, author.headers);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      saved: true,
      template: { activeVersion: t.version },
    });
    const before = await versionCount(t.id);
    expect(await versionCount(t.id)).toBe(before);
    expect(
      await first(env.DB, 'SELECT active_version FROM templates WHERE id = ?', [t.id]),
    ).toEqual({
      active_version: t.version,
    });
  });

  it.each(['session', 'membership'] as const)(
    'fences a %s revoked immediately before the version transaction',
    async (revoked) => {
      const t = await seed(orgId, `Racing ${revoked}`);
      const author = await member(orgId, ['template_author']);
      await call('/baked:starter-generic');
      const beforeTemplate = await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id]);
      const beforeVersions = await all(
        env.DB,
        'SELECT * FROM template_versions WHERE template_id = ?',
        [t.id],
      );
      const beforeAudits = await all(env.DB, 'SELECT * FROM audit_log WHERE target_id = ?', [t.id]);
      const beforeObjects = (
        await env.BUCKET.list({ prefix: `templates/${orgId}/${t.id}/` })
      ).objects.map((object) => object.key);
      let prepared = false;
      let intervened = false;
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              if (/INSERT\s+INTO\s+template_versions/i.test(sql)) prepared = true;
              return target.prepare(sql);
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (prepared && !intervened) {
                intervened = true;
                if (revoked === 'session')
                  await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                    clock.now(),
                    author.sessionId,
                  ]);
                else
                  await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                    clock.now(),
                    author.membershipId,
                  ]);
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const response = await app.request(
        `${ORIGIN}/api/v1/templates/${t.id}/versions`,
        {
          method: 'POST',
          headers: { ...author.headers, 'content-type': 'application/json' },
          body: JSON.stringify(
            draft({
              assets: same(t.assets),
              manifest: manifest(`Revoked ${revoked}`),
            }),
          ),
        },
        { ...env, DB: db },
      );
      expect(intervened).toBe(true);
      // A revoked member no longer sees the template, so the refusal is masked as not found.
      expect(response.status).toBe(revoked === 'membership' ? 404 : 403);
      expect(await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id])).toEqual(
        beforeTemplate,
      );
      expect(
        await all(env.DB, 'SELECT * FROM template_versions WHERE template_id = ?', [t.id]),
      ).toEqual(beforeVersions);
      expect(await all(env.DB, 'SELECT * FROM audit_log WHERE target_id = ?', [t.id])).toEqual(
        beforeAudits,
      );
      expect(
        (await env.BUCKET.list({ prefix: `templates/${orgId}/${t.id}/` })).objects.map(
          (object) => object.key,
        ),
      ).toEqual(beforeObjects);
    },
  );

  it('answers the same in test mode', async () => {
    const res = await save(mine.id, draft({ dryRun: true }), {
      ...admin,
      'x-passbook-mode': 'test',
    });
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
