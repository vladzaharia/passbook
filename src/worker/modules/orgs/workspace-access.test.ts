/// <reference types="vite/client" />

import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  editSessionAuthority,
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import { ProblemSchema } from '../../../shared/contracts/common.ts';
import { OrgMembershipListSchema, type OrgRole } from '../../../shared/contracts/org-membership.ts';
import { OrgSchema, OrgSummarySchema } from '../../../shared/contracts/orgs.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { generatedSource, syncBakedTemplates } from '../templates/sync.ts';
import { fakeAssets } from '../templates/testing.ts';
import { brandingFiles, brandingKey } from './branding-files.ts';
import { getOrgRow } from './repo.ts';
import { saveOrgBranding, updateOrgRow } from './repo-org-writes.ts';

const platformOrg = OrgSummarySchema.pick({
  id: true,
  slug: true,
  name: true,
  status: true,
  createdAt: true,
  counts: true,
  countsCapped: true,
}).strict();

let fx: Fixtures;
let org: OrgRow;
let app: OpenAPIHono<AppBindings>;
const assets = fakeAssets();

beforeAll(async () => {
  const bakedFiles = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  for (const template of generatedSource.templates) {
    const entries = [
      ...template.assets.map((asset) => ({ name: asset.name, path: asset.source.path })),
      ...template.extras,
    ];
    for (const entry of entries) {
      const data = bakedFiles[`../../../../templates/${template.slug}/${entry.name}`];
      if (!data?.startsWith('data:') || !data.includes(';base64,'))
        throw new Error(`Missing baked fixture: ${template.slug}/${entry.name}`);
      assets.files.set(
        entry.path,
        Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0)),
      );
    }
  }
  const env = await makeEnv({ ASSETS: assets });
  await syncBakedTemplates(createServiceContext(env, { clock: new ManualClock() }));
}, 60_000);

beforeEach(async () => {
  const env = await makeEnv({ ASSETS: assets });
  const clock = new ManualClock();
  fx = fixtures(env, clock);
  org = await makeOrg(fx, { name: 'Workspace Climbing' });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(env, clock),
      apiKeys: createApiKeyStore(env, clock),
    },
    clock,
  });
});

/** Accepted invitations and memberships are persisted, as are the sessions used by the app. */
async function principal(options: { role?: OrgRole; platform?: boolean; orgId?: string } = {}) {
  const user = await makeUser(fx);
  let membershipId: string | undefined;
  if (options.role) {
    const orgId = options.orgId ?? org.id;
    const invitationId = fx.ids.id();
    membershipId = fx.ids.id();
    const now = fx.clock.now();
    const roles = JSON.stringify([options.role]);
    await run(
      fx.env.DB,
      `INSERT INTO org_invitations
       (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [invitationId, orgId, user.primaryEmail, roles, fx.ids.token(), now, now + 3600_000, now],
    );
    await run(
      fx.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [membershipId, orgId, user.id, invitationId, roles, now],
    );
  }
  const session = await makeSession(fx, {
    userId: user.id,
    roles: options.platform ? ['admin', 'user'] : ['user'],
  });
  return { user, session, membershipId };
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const response = await app.request(
    `https://passbook.mobile/api/v1/orgs${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    fx.env,
    context,
  );
  await Promise.allSettled(pending);
  return response;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const logo3 = makePng(300, 90);
const logo2 = makePng(200, 60);
const logo = { x3: b64(logo3), x2: b64(logo2) };
const replacementLogo = { x3: b64(makePng(480, 150)), x2: b64(makePng(320, 100)) };

async function orgState(id = org.id) {
  return first(fx.env.DB, 'SELECT * FROM orgs WHERE id = ?', [id]);
}

async function auditState(id = org.id) {
  return all(fx.env.DB, 'SELECT * FROM audit_log WHERE org_id = ? ORDER BY id', [id]);
}

async function image(headers: Record<string, string>, scale: '2x' | '3x' = '3x') {
  const response = await call('GET', `/${org.id}/branding/logo/${scale}`, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-cache');
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadLogo(headers: Record<string, string>) {
  const response = await call('PUT', `/${org.id}/branding/logo`, headers, logo);
  expect(response.status).toBe(200);
}

describe('organization workspace authorization', () => {
  it('lets an explicit org_admin read and manage the workspace without a platform role', async () => {
    const manager = await principal({ role: 'org_admin' });
    const headers = manager.session.headers;
    const detail = await call('GET', `/${org.id}/workspace`, headers);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: org.id,
      name: org.name,
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
    });
    expect((await call('GET', `/${org.id}`, headers)).status).toBe(403);

    const patch = await call('PATCH', `/${org.id}`, headers, {
      name: 'Renamed Workspace',
      branding: { accent: '#112233', supportEmail: 'help@example.test' },
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      name: 'Renamed Workspace',
      branding: { accent: '#112233', supportEmail: 'help@example.test' },
    });
    await uploadLogo(headers);
    expect(await image(headers)).toEqual(logo3);
    expect(await image(headers, '2x')).toEqual(logo2);
    const preview = await call('GET', `/${org.id}/email-preview`, headers);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(await preview.text()).toContain('Renamed Workspace');
    const removed = await call('DELETE', `/${org.id}/branding/logo`, headers);
    expect(removed.status).toBe(200);
    expect(OrgSchema.parse(await removed.json()).branding).not.toHaveProperty('logo');
    expect((await call('GET', `/${org.id}/branding/logo/3x`, headers)).status).toBe(404);

    const { 'x-csrf-token': _csrf, ...withoutCsrf } = headers;
    expect((await call('PATCH', `/${org.id}`, withoutCsrf, { name: 'No CSRF' })).status).toBe(403);
  });

  it('applies the same provisioning and membership boundaries to HEAD requests', async () => {
    const member = await principal({ role: 'org_admin' });
    const outsider = await principal();
    const platform = await principal({ platform: true });
    const missing = fx.ids.id();
    for (const headers of [member.session.headers, outsider.session.headers]) {
      expect((await call('HEAD', `/${org.id}`, headers)).status).toBe(403);
      expect((await call('HEAD', `/${missing}`, headers)).status).toBe(403);
    }
    expect((await call('HEAD', `/${org.id}`, platform.session.headers)).status).toBe(200);
    expect((await call('HEAD', `/${org.id}/workspace`, member.session.headers)).status).toBe(200);
    expect((await call('HEAD', `/${missing}/workspace`, member.session.headers)).status).toBe(403);
    expect((await call('HEAD', `/${org.id}/workspace`, outsider.session.headers)).status).toBe(403);
    expect((await call('HEAD', `/${missing}/workspace`, outsider.session.headers)).status).toBe(
      403,
    );
    expect((await call('HEAD', `/${org.id}/workspace`, platform.session.headers)).status).toBe(403);
    expect((await call('HEAD', `/${org.id}/workspace`)).status).toBe(401);
  });

  it('reads legacy stable branding objects and keeps new storage versions out of DTOs', async () => {
    const manager = await principal({ role: 'org_admin' });
    const reader = await principal({ role: 'read_only' });
    const legacy = { sha: await sha256Hex(logo3), w: 300, h: 90 };
    await fx.env.BUCKET.put(brandingKey(org.id, 'logo', 3), logo3);
    await fx.env.BUCKET.put(brandingKey(org.id, 'logo', 2), logo2);
    await run(fx.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ logo: legacy }),
      org.id,
    ]);

    expect(await image(reader.session.headers)).toEqual(logo3);
    expect(await image(reader.session.headers, '2x')).toEqual(logo2);
    expect(await brandingFiles(fx.env.BUCKET, org.id, [{ slot: 'logo', ...legacy }])).toEqual([
      expect.objectContaining({
        name: 'logo@3x.png',
        r2Key: brandingKey(org.id, 'logo', 3),
        version: legacy.sha,
      }),
      expect.objectContaining({
        name: 'logo@2x.png',
        r2Key: brandingKey(org.id, 'logo', 2),
        version: legacy.sha,
      }),
    ]);
    const preview = await call('GET', `/${org.id}/email-preview`, reader.session.headers);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(
      `/api/v1/orgs/${org.id}/branding/logo/3x?v=${legacy.sha}`,
    );

    const upload = await call('PUT', `/${org.id}/branding/logo`, manager.session.headers, logo);
    expect(upload.status).toBe(200);
    const uploadedBody = await upload.text();
    expect(uploadedBody).not.toContain('storageVersion');
    expect(OrgSchema.parse(JSON.parse(uploadedBody)).branding.logo).toMatchObject(legacy);
    const detail = await call('GET', `/${org.id}/workspace`, reader.session.headers);
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain('storageVersion');

    const stored = await first<{ branding: string }>(
      fx.env.DB,
      'SELECT branding FROM orgs WHERE id = ?',
      [org.id],
    );
    if (!stored) throw new Error('The organization must still exist.');
    const current = z
      .object({
        logo: z.object({
          sha: z.string(),
          w: z.number(),
          h: z.number(),
          storageVersion: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      })
      .parse(JSON.parse(stored.branding));
    expect(current.logo).toMatchObject(legacy);
    expect(await brandingFiles(fx.env.BUCKET, org.id, [{ slot: 'logo', ...current.logo }])).toEqual(
      [
        expect.objectContaining({
          name: 'logo@3x.png',
          r2Key: brandingKey(org.id, 'logo', 3, current.logo.storageVersion),
          version: current.logo.storageVersion,
        }),
        expect.objectContaining({
          name: 'logo@2x.png',
          r2Key: brandingKey(org.id, 'logo', 2, current.logo.storageVersion),
          version: current.logo.storageVersion,
        }),
      ],
    );
    expect(await image(reader.session.headers)).toEqual(logo3);
  });

  it('allows pass operators to read details, images and previews, but not manage', async () => {
    const manager = await principal({ role: 'org_admin' });
    const operator = await principal({ role: 'pass_operator' });
    await uploadLogo(manager.session.headers);
    const before = await orgState();
    const audits = await auditState();
    const headers = operator.session.headers;

    const detail = await call('GET', `/${org.id}/workspace`, headers);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: org.id, name: org.name });
    expect((await call('GET', `/${org.id}`, headers)).status).toBe(403);
    expect(await image(headers)).toEqual(logo3);
    expect(await image(headers, '2x')).toEqual(logo2);
    const preview = await call('GET', `/${org.id}/email-preview`, headers);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(await preview.text()).toContain(org.name);
    for (const response of [
      await call('PATCH', `/${org.id}`, headers, { name: 'Forbidden' }),
      await call('PATCH', `/${org.id}`, headers, { branding: { accent: '#ffffff' } }),
      await call('PUT', `/${org.id}/branding/logo`, headers, replacementLogo),
      await call('DELETE', `/${org.id}/branding/logo`, headers),
    ])
      expect(response.status).toBe(403);
    expect(await orgState()).toEqual(before);
    expect(await auditState()).toEqual(audits);
    expect(await image(manager.session.headers)).toEqual(logo3);
    expect(await image(manager.session.headers, '2x')).toEqual(logo2);
  });

  it('permits preview with templates:read even without org:manage', async () => {
    const author = await principal({ role: 'template_author' });
    const headers = author.session.headers;
    const preview = await call('GET', `/${org.id}/email-preview`, headers);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(await preview.text()).toContain(org.name);
    expect((await call('PATCH', `/${org.id}`, headers, { name: 'Forbidden' })).status).toBe(403);
  });

  it('denies a non-member platform admin workspace access but allows provisioning and lifecycle', async () => {
    const manager = await principal({ role: 'org_admin' });
    const platform = await principal({ platform: true });
    const headers = platform.session.headers;
    await uploadLogo(manager.session.headers);
    const before = await orgState();
    const audits = await auditState();
    for (const response of [
      await call('GET', `/${org.id}/workspace`, headers),
      await call('PATCH', `/${org.id}`, headers, { name: 'Forbidden' }),
      await call('PUT', `/${org.id}/branding/logo`, headers, replacementLogo),
      await call('DELETE', `/${org.id}/branding/logo`, headers),
      await call('GET', `/${org.id}/branding/logo/3x`, headers),
      await call('GET', `/${org.id}/email-preview`, headers),
    ])
      expect(response.status).toBe(403);
    expect(await orgState()).toEqual(before);
    expect(await auditState()).toEqual(audits);
    expect(await image(manager.session.headers)).toEqual(logo3);
    const provisioning = await call('GET', `/${org.id}`, headers);
    expect(provisioning.status).toBe(200);
    const provisioningBody = platformOrg.parse(await provisioning.json());
    expect(provisioningBody).toMatchObject({
      id: org.id,
      slug: org.slug,
      name: org.name,
      status: 'active',
      createdAt: fx.clock.now(),
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
    });

    const directory = await call('GET', `?q=${org.slug}`, headers);
    expect(directory.status).toBe(200);
    const directoryBody = z.object({ items: z.array(platformOrg) }).parse(await directory.json());
    expect(directoryBody.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: org.id })]),
    );
    const created = await call('POST', '', headers, {
      slug: `workspace-${fx.ids.id().slice(-8)}`,
      name: 'Lifecycle Org',
    });
    expect(created.status).toBe(201);
    const { id } = OrgSchema.parse(await created.json());
    expect((await call('GET', `/${id}/workspace`, headers)).status).toBe(403);
    expect((await call('GET', `/${id}`, headers)).status).toBe(200);
    const suspended = await call('POST', `/${id}/status`, headers, { status: 'suspended' });
    expect(suspended.status).toBe(200);
    expect(platformOrg.parse(await suspended.json())).toMatchObject({ id, status: 'suspended' });
    const active = await call('POST', `/${id}/status`, headers, { status: 'active' });
    expect(active.status).toBe(200);
    expect(platformOrg.parse(await active.json())).toMatchObject({ id, status: 'active' });
    expect((await call('DELETE', `/${id}`, headers)).status).toBe(200);
    expect(await orgState(id)).toMatchObject({ status: 'deleted' });
  });

  it('keeps directory, creation, deletion and status platform-only and rejects PATCH status bypasses', async () => {
    const manager = await principal({ role: 'org_admin' });
    const headers = manager.session.headers;
    const before = await orgState();
    const audits = await auditState();
    for (const response of [
      await call('GET', '', headers),
      await call('POST', '', headers, { slug: `denied-${fx.ids.id().slice(-8)}`, name: 'No' }),
      await call('DELETE', `/${org.id}`, headers),
      await call('POST', `/${org.id}/status`, headers, { status: 'suspended' }),
      await call('PATCH', `/${org.id}`, headers, { status: 'suspended' }),
      await call('PATCH', `/${org.id}`, headers, { name: 'Partial write', status: 'suspended' }),
    ])
      expect(response.status).toBe(403);
    expect(await orgState()).toEqual(before);
    expect(await auditState()).toEqual(audits);
  });

  it('masks a different organization and a missing ID with the same denial', async () => {
    const manager = await principal({ role: 'org_admin' });
    const other = await makeOrg(fx, { name: 'Other Workspace' });
    const missing = fx.ids.id();
    const before = await orgState(other.id);
    const headers = manager.session.headers;
    const operations: { method: string; path: (id: string) => string; body?: unknown }[] = [
      { method: 'GET', path: (id) => `/${id}/workspace` },
      { method: 'PATCH', path: (id) => `/${id}`, body: { name: 'Forbidden' } },
      { method: 'PUT', path: (id) => `/${id}/branding/logo`, body: logo },
      { method: 'DELETE', path: (id) => `/${id}/branding/logo` },
      { method: 'GET', path: (id) => `/${id}/branding/logo/3x` },
      { method: 'GET', path: (id) => `/${id}/email-preview` },
    ];
    for (const operation of operations) {
      const foreign = await call(
        operation.method,
        operation.path(other.id),
        headers,
        operation.body,
      );
      const absent = await call(operation.method, operation.path(missing), headers, operation.body);
      expect(foreign.status).toBe(403);
      expect(absent.status).toBe(foreign.status);
      const a = ProblemSchema.parse(await foreign.json());
      const b = ProblemSchema.parse(await absent.json());
      expect({ code: a.code, detail: a.detail }).toEqual({ code: b.code, detail: b.detail });
    }
    const platformMember = await principal({ role: 'org_admin', platform: true });
    for (const sessionHeaders of [headers, platformMember.session.headers]) {
      for (const operation of operations) {
        const response = await call(
          operation.method,
          `${operation.path(other.id)}?orgId=${encodeURIComponent(org.id)}`,
          sessionHeaders,
          operation.body,
        );
        expect(response.status).toBe(403);
      }
    }
    expect(await orgState(other.id)).toEqual(before);
  });

  it('preserves the independently guarded membership endpoints', async () => {
    const manager = await principal({ role: 'org_admin' });
    const operator = await principal({ role: 'pass_operator' });
    const platform = await principal({ platform: true });
    const my = await call('GET', '/memberships/me', operator.session.headers);
    expect(my.status).toBe(200);
    expect(OrgMembershipListSchema.parse(await my.json()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: operator.membershipId })]),
    );
    const noMemberships = await call('GET', '/memberships/me', platform.session.headers);
    expect(await noMemberships.json()).toEqual({ items: [] });
    expect((await call('GET', `/${org.id}/memberships`, operator.session.headers)).status).toBe(
      403,
    );
    for (const headers of [manager.session.headers, platform.session.headers]) {
      const members = await call('GET', `/${org.id}/memberships`, headers);
      expect(members.status).toBe(200);
      expect(OrgMembershipListSchema.parse(await members.json()).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: operator.membershipId })]),
      );
      expect((await call('GET', `/${org.id}/invitations`, headers)).status).toBe(200);
    }
    expect((await call('GET', '/memberships/me')).status).toBe(401);
    expect((await call('GET', '/invitations/accept')).status).toBe(200);
    const revoked = await call(
      'DELETE',
      `/${org.id}/memberships/${operator.membershipId}`,
      platform.session.headers,
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
    expect(await (await call('GET', '/memberships/me', operator.session.headers)).json()).toEqual({
      items: [],
    });
    expect((await call('GET', `/${org.id}/workspace`, operator.session.headers)).status).toBe(403);
  });

  it('requires a live session and an active membership, user and organization', async () => {
    const member = await principal({ role: 'org_admin' });
    const key = await makeApiKey(fx, { orgId: org.id });
    expect((await call('GET', `/${org.id}/workspace`)).status).toBe(401);
    expect((await call('GET', `/${org.id}/workspace`, key.headers)).status).toBe(401);
    expect((await call('GET', `/${org.id}/workspace`, member.session.headers)).status).toBe(200);
    await uploadLogo(member.session.headers);
    expect(await image(member.session.headers)).toEqual(logo3);
    await run(fx.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      fx.clock.now(),
      member.membershipId,
    ]);
    expect((await call('GET', `/${org.id}/workspace`, member.session.headers)).status).toBe(403);
    expect((await call('GET', `/${org.id}/branding/logo/3x`, member.session.headers)).status).toBe(
      403,
    );
    expect((await call('PATCH', `/${org.id}`, member.session.headers, { name: 'No' })).status).toBe(
      403,
    );

    const disabled = await principal({ role: 'org_admin' });
    await run(fx.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.user.id]);
    expect((await call('GET', `/${org.id}/workspace`, disabled.session.headers)).status).toBe(401);
    const revokedSession = await principal({ role: 'org_admin' });
    await run(fx.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      fx.clock.now(),
      await hashSessionCookie(revokedSession.session.cookieValue),
    ]);
    expect((await call('GET', `/${org.id}/workspace`, revokedSession.session.headers)).status).toBe(
      401,
    );

    const active = await principal({ role: 'org_admin' });
    const platform = await principal({ platform: true });
    expect(
      (await call('POST', `/${org.id}/status`, platform.session.headers, { status: 'suspended' }))
        .status,
    ).toBe(200);
    expect((await call('GET', `/${org.id}/workspace`, active.session.headers)).status).toBe(403);
  });
});

describe('organization revision', () => {
  it('advances on every same-tick metadata, branding, status and deletion change', async () => {
    const manager = await principal({ role: 'org_admin' });
    const platformMember = await principal({ role: 'org_admin', platform: true });
    const platform = await principal({ platform: true });
    let revision = fx.clock.now();
    const expectRevision = async (response: Response, platform = false) => {
      expect(response.status).toBe(200);
      revision++;
      if (platform) {
        expect(platformOrg.parse(await response.json())).toMatchObject({ id: org.id });
      } else {
        expect(await response.json()).toMatchObject({ updatedAt: revision });
      }
      expect(await orgState()).toMatchObject({ updated_at: revision });
    };
    await expectRevision(
      await call('PATCH', `/${org.id}`, manager.session.headers, {
        name: 'First edit',
        branding: { accent: '#112233' },
      }),
    );
    await expectRevision(
      await call('PUT', `/${org.id}/branding/logo`, manager.session.headers, logo),
    );
    await expectRevision(await call('DELETE', `/${org.id}/branding/logo`, manager.session.headers));
    await expectRevision(
      await call('PATCH', `/${org.id}`, platformMember.session.headers, { status: 'suspended' }),
    );
    await expectRevision(
      await call('POST', `/${org.id}/status`, platform.session.headers, { status: 'active' }),
      true,
    );
    await expectRevision(
      await call('POST', `/${org.id}/status`, platform.session.headers, { status: 'suspended' }),
      true,
    );
    await expectRevision(
      await call('POST', `/${org.id}/status`, platform.session.headers, { status: 'active' }),
      true,
    );

    fx.clock.advance(10_000);
    const later = await call('PATCH', `/${org.id}`, manager.session.headers, {
      name: 'Later edit',
    });
    expect(later.status).toBe(200);
    revision = fx.clock.now();
    expect(await later.json()).toMatchObject({ updatedAt: revision });
    expect(await orgState()).toMatchObject({ updated_at: revision });
    fx.clock.set(fx.clock.now() - 5_000);
    await expectRevision(
      await call('PATCH', `/${org.id}`, manager.session.headers, {
        name: 'Clock moved backwards',
      }),
    );
    const deleted = await call('DELETE', `/${org.id}`, platform.session.headers);
    expect(deleted.status).toBe(200);
    expect(await orgState()).toMatchObject({ status: 'deleted', updated_at: revision + 1 });
  });
});

/** Intervene immediately before the actual org UPDATE, including if it is part of a D1 batch. */
async function atOrgWrite(
  intervene: (db: D1Database) => Promise<void>,
  request: () => Promise<Response>,
) {
  const db = fx.env.DB;
  const texts = new WeakMap<D1PreparedStatement, string>();
  const reals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let hits = 0;
  const before = async (sql: string[]) => {
    if (hits === 0 && sql.some((text) => /\bUPDATE\s+(?:"orgs"|orgs\b)/i.test(text))) {
      hits++;
      await intervene(db);
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === 'run' || prop === 'first' || prop === 'all' || prop === 'raw') {
          return async (...args: unknown[]) => {
            await before([sql]);
            return (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    texts.set(proxy, sql);
    reals.set(proxy, statement);
    return proxy;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await before(statements.map((statement) => texts.get(statement) ?? ''));
          return target.batch(statements.map((statement) => reals.get(statement) ?? statement));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(fx.env, { DB: proxy });
  try {
    const response = await request();
    expect(hits, 'the final organization write must be reached').toBe(1);
    return response;
  } finally {
    Object.assign(fx.env, { DB: db });
  }
}

async function workspaceMutation(
  operation: 'patch' | 'upload' | 'delete',
  headers: Record<string, string>,
) {
  if (operation === 'patch')
    return call('PATCH', `/${org.id}`, headers, { name: 'Stale authority' });
  if (operation === 'upload')
    return call('PUT', `/${org.id}/branding/logo`, headers, replacementLogo);
  return call('DELETE', `/${org.id}/branding/logo`, headers);
}

describe('organization mutation-time authority', () => {
  it.each([
    ['membership', 'patch'],
    ['membership', 'upload'],
    ['membership', 'delete'],
    ['session', 'patch'],
    ['session', 'upload'],
    ['session', 'delete'],
  ] as const)('rechecks a revoked %s at the final %s write', async (revoked, operation) => {
    const owner = await principal({ role: 'org_admin' });
    const subject = await principal({ role: 'org_admin' });
    await uploadLogo(owner.session.headers);
    const before = await orgState();
    const audits = await auditState();
    const keys = (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
      .map((object) => object.key)
      .sort();
    const response = await atOrgWrite(
      async (db) => {
        if (revoked === 'membership') {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            fx.clock.now(),
            subject.membershipId,
          ]);
        } else {
          await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
            fx.clock.now(),
            await hashSessionCookie(subject.session.cookieValue),
          ]);
        }
      },
      () => workspaceMutation(operation, subject.session.headers),
    );
    expect([401, 403, 404, 409, 412]).toContain(response.status);
    expect(await orgState()).toEqual(before);
    expect(await auditState()).toEqual(audits);
    expect(await image(owner.session.headers)).toEqual(logo3);
    expect(await image(owner.session.headers, '2x')).toEqual(logo2);
    expect(
      (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
        .map((object) => object.key)
        .sort(),
    ).toEqual(keys);
  });

  it.each(['membership', 'session'] as const)(
    'rechecks a revoked %s for PATCH status even with the platform role',
    async (revoked) => {
      const subject = await principal({ platform: true, role: 'org_admin' });
      const before = await orgState();
      const audits = await auditState();
      const response = await atOrgWrite(
        async (db) => {
          if (revoked === 'membership') {
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              fx.clock.now(),
              subject.membershipId,
            ]);
          } else {
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              fx.clock.now(),
              await hashSessionCookie(subject.session.cookieValue),
            ]);
          }
        },
        () => call('PATCH', `/${org.id}`, subject.session.headers, { status: 'suspended' }),
      );
      expect([401, 403, 404, 409, 412]).toContain(response.status);
      expect(await orgState()).toEqual(before);
      expect(await auditState()).toEqual(audits);
    },
  );

  it('binds repository writes to the real organization and org:manage capability', async () => {
    const manager = await principal({ role: 'org_admin' });
    const auth = await createSessionStore(fx.env, fx.clock).resolve(manager.session.cookieValue);
    if (!auth) throw new Error('The manager session must resolve.');
    const ctx = createServiceContext(fx.env, { clock: fx.clock });
    const manage = await tenantAuthorityOf(ctx, auth, org.id, 'org:manage');
    const read = await tenantAuthorityOf(ctx, auth, org.id, 'org:read');
    if (manage.kind !== 'session' || read.kind !== 'session')
      throw new Error('Expected session authorities.');
    const operator = await principal({ role: 'pass_operator' });
    const operatorAuth = await createSessionStore(fx.env, fx.clock).resolve(
      operator.session.cookieValue,
    );
    if (!operatorAuth) throw new Error('The operator session must resolve.');
    const operatorRead = await tenantAuthorityOf(ctx, operatorAuth, org.id, 'org:read');
    if (operatorRead.kind !== 'session') throw new Error('Expected an operator session authority.');
    const forgedCapability = { ...operatorRead, capability: 'org:manage' as const };

    const other = await makeOrg(fx, { name: 'Other Workspace' });
    const ownRow = await getOrgRow(fx.env.DB, org.id);
    const otherRow = await getOrgRow(fx.env.DB, other.id);
    if (!ownRow || !otherRow) throw new Error('Both organizations must exist.');
    const forged = { ...manage, orgId: other.id, orgUpdatedAt: otherRow.updated_at };
    const branding = JSON.stringify({ accent: '#112233' });
    const refused = { status: 403 };

    // An authority for another org is refused before any SQL; a forged one reaches the grant, which
    // takes the org from the membership row, so the other org's row never matches (409, nothing written).
    // Its ms-sized revision is read as pre-cutover work, accepted on org status alone.
    expect(await saveOrgBranding(ctx, otherRow, branding, fx.clock.now(), manage)).toBeNull();
    expect(await updateOrgRow(ctx, { ...otherRow, name: 'Cross-tenant write' }, manage)).toBeNull();
    await expect(
      saveOrgBranding(ctx, otherRow, branding, fx.clock.now(), forged),
    ).rejects.toMatchObject({ status: 409, code: 'SETTINGS_CHANGED' });
    await expect(
      updateOrgRow(ctx, { ...otherRow, name: 'Cross-tenant write' }, forged),
    ).rejects.toMatchObject({ status: 409, code: 'SETTINGS_CHANGED' });
    expect(await saveOrgBranding(ctx, ownRow, branding, fx.clock.now(), read)).toBeNull();
    expect(await updateOrgRow(ctx, { ...ownRow, name: 'Read-only write' }, read)).toBeNull();
    // A hand-built capability does not hold: the grant re-derives it from the membership's roles.
    await expect(
      saveOrgBranding(ctx, ownRow, branding, fx.clock.now(), forgedCapability),
    ).rejects.toMatchObject({ ...refused, code: 'ACTOR_CHANGED' });
    await expect(
      updateOrgRow(ctx, { ...ownRow, name: 'Forged capability' }, forgedCapability),
    ).rejects.toMatchObject({ ...refused, code: 'ACTOR_CHANGED' });
    expect(await getOrgRow(fx.env.DB, org.id)).toEqual(ownRow);
    expect(await getOrgRow(fx.env.DB, other.id)).toEqual(otherRow);
  });

  it.each(['patch', 'upload', 'delete'] as const)(
    'rejects a stale %s after another organization revision commits',
    async (operation) => {
      const owner = await principal({ role: 'org_admin' });
      const subject = await principal({ role: 'org_admin' });
      await uploadLogo(owner.session.headers);
      const before = await getOrgRow(fx.env.DB, org.id);
      if (!before) throw new Error('The organization must exist.');
      const audits = await auditState();
      const keys = (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
        .map((object) => object.key)
        .sort();

      const response = await atOrgWrite(
        async (db) => {
          await run(db, 'UPDATE orgs SET name = ?, updated_at = updated_at + 1 WHERE id = ?', [
            'Concurrent winner',
            org.id,
          ]);
        },
        () => workspaceMutation(operation, subject.session.headers),
      );
      // The concurrent edit moved config_revision: the derived write is a 409 to refetch, not a 403.
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
      const after = await getOrgRow(fx.env.DB, org.id);
      expect(after).toMatchObject({
        ...before,
        config_revision: expect.any(Number),
        name: 'Concurrent winner',
        updated_at: before.updated_at + 1,
      });
      expect(after?.config_revision).toBeGreaterThan(before.config_revision);
      expect(await auditState()).toEqual(audits);
      expect(await image(owner.session.headers)).toEqual(logo3);
      expect(await image(owner.session.headers, '2x')).toEqual(logo2);
      expect(
        (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
          .map((object) => object.key)
          .sort(),
      ).toEqual(keys);
    },
  );

  it.each([
    ['suspended', 'patch'],
    ['suspended', 'upload'],
    ['suspended', 'delete'],
    ['deleted', 'patch'],
    ['deleted', 'upload'],
    ['deleted', 'delete'],
  ] as const)('rejects %s organization at the final %s write', async (status, operation) => {
    const owner = await principal({ role: 'org_admin' });
    const subject = await principal({ role: 'org_admin' });
    await uploadLogo(owner.session.headers);
    const before = await first<{ updated_at: number; branding: string } & Record<string, unknown>>(
      fx.env.DB,
      'SELECT * FROM orgs WHERE id = ?',
      [org.id],
    );
    if (!before) throw new Error('The organization must exist.');
    const version = z
      .object({ logo: z.object({ storageVersion: z.string() }) })
      .parse(JSON.parse(before.branding)).logo.storageVersion;
    const audits = await auditState();
    const keys = (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
      .map((object) => object.key)
      .sort();
    const response = await atOrgWrite(
      async (db) => {
        await run(db, 'UPDATE orgs SET status = ?, updated_at = updated_at + 1 WHERE id = ?', [
          status,
          org.id,
        ]);
      },
      () => workspaceMutation(operation, subject.session.headers),
    );
    expect([401, 403, 404, 409, 412]).toContain(response.status);
    // The injected status change moves the trigger-owned access_revision; nothing else changes.
    const after = await orgState();
    expect(after).toEqual({
      ...before,
      status,
      updated_at: before.updated_at + 1,
      access_revision: expect.any(Number),
    });
    expect((after as { access_revision: number }).access_revision).toBeGreaterThan(
      before.access_revision as number,
    );
    expect(await auditState()).toEqual(audits);
    expect(
      (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
        .map((object) => object.key)
        .sort(),
    ).toEqual(keys);
    for (const [scale, bytes] of [
      [3, logo3],
      [2, logo2],
    ] as const) {
      const object = await fx.env.BUCKET.get(brandingKey(org.id, 'logo', scale, version));
      expect(object).not.toBeNull();
      if (!object) throw new Error('The previous branding image must remain available.');
      expect(new Uint8Array(await object.arrayBuffer())).toEqual(bytes);
    }
  });

  it.each(['org_admin', 'read_only'] as const)(
    'rejects a stale request after membership replacement, even when reissued as %s',
    async (role) => {
      const subject = await principal({ role: 'org_admin' });
      const before = await orgState();
      const audits = await auditState();
      const response = await atOrgWrite(
        async (db) => {
          const now = fx.clock.now();
          const invitationId = fx.ids.id();
          const roles = JSON.stringify([role]);
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            now,
            subject.membershipId,
          ]);
          await run(
            db,
            `INSERT INTO org_invitations
             (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              invitationId,
              org.id,
              subject.user.primaryEmail,
              roles,
              fx.ids.token(),
              now,
              now + 3600_000,
              now,
            ],
          );
          await run(
            db,
            `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [fx.ids.id(), org.id, subject.user.id, invitationId, roles, now],
          );
        },
        () => workspaceMutation('patch', subject.session.headers),
      );
      expect([401, 403, 404, 409, 412]).toContain(response.status);
      expect(await orgState()).toEqual(before);
      expect(await auditState()).toEqual(audits);
      expect((await call('GET', `/${org.id}/workspace`, subject.session.headers)).status).toBe(200);
      const retried = await call('PATCH', `/${org.id}`, subject.session.headers, {
        name: 'New membership',
      });
      expect(retried.status).toBe(role === 'org_admin' ? 200 : 403);
    },
  );

  it.each([
    ['disabled user', 'patch'],
    ['session expiry', 'delete'],
    ['session idle expiry', 'upload'],
  ] as const)('rechecks %s at the final %s write', async (change, operation) => {
    const owner = await principal({ role: 'org_admin' });
    const subject = await principal({ role: 'org_admin' });
    await uploadLogo(owner.session.headers);
    const before = await orgState();
    const audits = await auditState();
    const keys = (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
      .map((object) => object.key)
      .sort();
    const response = await atOrgWrite(
      async (db) => {
        if (change === 'disabled user') {
          await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [subject.user.id]);
          return;
        }
        const idHash = await hashSessionCookie(subject.session.cookieValue);
        if (change === 'session expiry')
          await editSessionAuthority(db, 'UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [
            fx.clock.now(),
            idHash,
          ]);
        else if (change === 'session idle expiry')
          await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
            fx.clock.now(),
            idHash,
          ]);
      },
      () => workspaceMutation(operation, subject.session.headers),
    );
    expect([401, 403, 404, 409, 412]).toContain(response.status);
    expect(await orgState()).toEqual(before);
    expect(await auditState()).toEqual(audits);
    expect(await image(owner.session.headers)).toEqual(logo3);
    expect(await image(owner.session.headers, '2x')).toEqual(logo2);
    expect(
      (await fx.env.BUCKET.list({ prefix: `orgs/${org.id}/` })).objects
        .map((object) => object.key)
        .sort(),
    ).toEqual(keys);
  });

  it('refuses a PATCH from an older form with 409 and accepts a current or absent revision', async () => {
    const owner = await principal({ role: 'org_admin' });
    const loaded = (await getOrgRow(fx.env.DB, org.id))?.config_revision ?? 0;
    const patch = (name: string, configRevision?: number) =>
      call('PATCH', `/${org.id}`, owner.session.headers, {
        name,
        ...(configRevision === undefined ? {} : { configRevision }),
      });
    expect((await patch('First save', loaded)).status).toBe(200);
    const stale = await patch('Second admin, older form', loaded);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect((await getOrgRow(fx.env.DB, org.id))?.name).toBe('First save');
    const fresh = (await getOrgRow(fx.env.DB, org.id))?.config_revision ?? 0;
    expect((await patch('Current form', fresh)).status).toBe(200);
    expect((await patch('No revision sent')).status).toBe(200);
  });

  // Roles and amr are immutable (0047) and checked once in JS: a mid-request edit is refused and the write lands.
  it.each([
    ['roles', 'UPDATE sessions SET roles = \'["user"]\' WHERE id_hash = ?', 'patch'],
    ['authentication method', "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ?", 'upload'],
  ] as const)('cannot change the session %s under an org %s', async (_what, sql, operation) => {
    const subject = await principal({ platform: true, role: 'org_admin' });
    const response = await atOrgWrite(
      async (db) => {
        await expect(
          run(db, sql, [await hashSessionCookie(subject.session.cookieValue)]),
        ).rejects.toThrow('session authority is immutable');
      },
      () => workspaceMutation(operation, subject.session.headers),
    );
    expect(response.status).toBe(200);
  });
});
