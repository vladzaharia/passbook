/// <reference types="vite/client" />

import { expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  SaveVersionResponseSchema,
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { crc32, sha1Hex } from './package/hash.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets } from './testing.ts';

const STARTERS = [
  ['generic', ['generic']],
  ['coupon', ['coupon']],
  ['event-ticket', ['eventTicket']],
  ['store-card', ['storeCard']],
  ['boarding-pass', ['boardingPass']],
  ['poster-generic', ['generic', 'posterGeneric']],
] as const;

it('starter clones open in the designer as inactive drafts, and a draft can be saved', async () => {
  const clock = new ManualClock(Date.now());
  const assets = fakeAssets();
  // Workerd has no filesystem; Vite embeds the source bytes used to build the baked index.
  const bakedFiles = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  const bytesFor = (slug: string, name: string) => {
    const data = bakedFiles[`../../../../templates/${slug}/${name}`];
    if (!data?.startsWith('data:') || !data.includes(';base64,'))
      throw new Error(`Missing baked fixture bytes: ${slug}/${name}`);
    return Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  };
  for (const t of generatedSource.templates) {
    for (const a of t.assets) {
      const bytes = bytesFor(t.slug, a.name);
      if (bytes.length !== a.size || (await sha1Hex(bytes)) !== a.sha1 || crc32(bytes) !== a.crc32)
        throw new Error(`Baked fixture does not match generated metadata: ${t.slug}/${a.name}`);
      assets.files.set(a.source.path, bytes);
    }
    for (const extra of t.extras) {
      const bytes = bytesFor(t.slug, extra.name);
      if (bytes.length !== extra.size || (await sha1Hex(bytes)) !== extra.sha1)
        throw new Error(`Baked extra does not match generated metadata: ${t.slug}/${extra.name}`);
      assets.files.set(extra.path, bytes);
    }
  }
  const env = await makeEnv({ ASSETS: assets });
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
  const outsider = (
    await makeSession(f, {
      userId: (await makeUser(f)).id,
      roles: ['admin', 'user'],
    })
  ).headers;
  const call = (path: string, body?: unknown, headers: Record<string, string> = admin) =>
    app.request(
      `https://wallet.test/api/v1/templates${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const unscoped = await call('/baked:starter-generic');
  expect(unscoped.status).toBe(403);
  expect(await unscoped.json()).toMatchObject({ code: 'ORG_REQUIRED' });
  expect((await call(`/baked:starter-generic?orgId=${org.id}`, undefined, outsider)).status).toBe(
    404,
  );
  expect(
    (
      await call(
        '/baked:starter-generic/clone',
        {
          orgId: org.id,
          name: 'Unauthorized copy',
        },
        outsider,
      )
    ).status,
  ).toBe(404);

  for (const [slug, styles] of STARTERS) {
    const sourceId = `baked:starter-${slug}`;
    const sourceResponse = await call(`/${sourceId}?orgId=${org.id}`);
    expect(sourceResponse.status, slug).toBe(200);
    const source = TemplateDetailSchema.parse(await sourceResponse.json());
    expect(source).toMatchObject({ id: sourceId, orgId: null, origin: 'baked', styles });
    const sourceVersion = source.activeVersion;
    if (!sourceVersion) throw new Error(`Starter ${slug} has no active version`);
    const sourceVersionResponse = await call(
      `/${sourceId}/versions/${sourceVersion}?orgId=${org.id}`,
    );
    expect(sourceVersionResponse.status, slug).toBe(200);
    const sourceVersionDetail = TemplateVersionDetailSchema.parse(
      await sourceVersionResponse.json(),
    );
    expect(sourceVersionDetail).toMatchObject({ version: sourceVersion, active: true });

    const clone = await call(`/${sourceId}/clone`, { orgId: org.id, name: `Copy ${slug}` });
    expect(clone.status, slug).toBe(201);
    const cloned = TemplateDetailSchema.parse(await clone.json());
    expect(cloned).toMatchObject({
      orgId: org.id,
      origin: 'uploaded',
      name: `Copy ${slug}`,
      activeVersion: null,
      styles,
    });
    const detailResponse = await call(`/${cloned.id}`);
    expect(detailResponse.status, slug).toBe(200);
    const detail = TemplateDetailSchema.parse(await detailResponse.json());
    expect(detail.activeVersion, slug).toBeNull();
    expect(detail.versions, slug).toHaveLength(1);
    const version = detail.versions[0];
    if (!version) throw new Error(`Clone of ${slug} has no saved version`);
    expect(version.active, slug).toBe(false);
    const versionResponse = await call(`/${cloned.id}/versions/${version.version}`);
    expect(versionResponse.status, slug).toBe(200);
    const v = TemplateVersionDetailSchema.parse(await versionResponse.json());
    expect(v).toMatchObject({
      version: version.version,
      active: false,
      manifest: { name: `Copy ${slug}` },
      passJson: sourceVersionDetail.passJson,
    });
    expect(v.assets.map(({ name, sha1 }) => ({ name, sha1 }))).toEqual(
      sourceVersionDetail.assets.map(({ name, sha1 }) => ({ name, sha1 })),
    );
    for (const style of styles) expect(v.passJson, slug).toHaveProperty(style);
    const draft = {
      passJson: v.passJson,
      manifest: v.manifest,
      assets: v.assets.map(({ name, sha1 }) => ({ name, sha1 })),
    };
    const res = await call(`/${cloned.id}/versions`, { ...draft, dryRun: true });
    expect(res.status, slug).toBe(200);
    const body = SaveVersionResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ saved: false });
    expect(
      body.report.issues.filter((i) => i.severity === 'error'),
      slug,
    ).toEqual([]);
    expect(body.passJson, slug).not.toBeNull();

    if (slug === 'generic') {
      expect((await call(`/${cloned.id}`, undefined, outsider)).status).toBe(404);
      expect((await call(`/${cloned.id}/versions`, draft, outsider)).status).toBe(404);
      const saved = await call(`/${cloned.id}/versions`, {
        ...draft,
        passJson: { ...draft.passJson, description: 'Edited starter draft' },
      });
      expect(saved.status).toBe(200);
      const result = SaveVersionResponseSchema.parse(await saved.json());
      expect(result).toMatchObject({
        saved: true,
        created: true,
        template: { activeVersion: null },
      });
      const savedVersion = result.version;
      if (!savedVersion || !result.template)
        throw new Error('Saved draft has no version or template');
      expect(savedVersion).not.toBe(version.version);
      expect(result.template.versions).toEqual(
        expect.arrayContaining([expect.objectContaining({ version: savedVersion, active: false })]),
      );
      const savedVersionResponse = await call(`/${cloned.id}/versions/${savedVersion}`);
      expect(savedVersionResponse.status).toBe(200);
      expect(TemplateVersionDetailSchema.parse(await savedVersionResponse.json())).toMatchObject({
        version: savedVersion,
        active: false,
        manifest: v.manifest,
        passJson: { ...v.passJson, description: 'Edited starter draft' },
      });
      const activation = await call(`/${cloned.id}/activate`, { version: savedVersion });
      expect(activation.status).toBe(404);
      const savedDetail = await call(`/${cloned.id}`);
      expect(savedDetail.status).toBe(200);
      expect(TemplateDetailSchema.parse(await savedDetail.json())).toMatchObject({
        activeVersion: null,
        versions: expect.arrayContaining([
          expect.objectContaining({ version: savedVersion, active: false }),
        ]),
      });
    }
  }
}, 60_000);
