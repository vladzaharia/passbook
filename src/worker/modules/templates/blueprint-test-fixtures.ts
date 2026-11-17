/// <reference types="vite/client" />

import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { renderStampFiles } from '../../../passkit/stamps/package.ts';
import type { StampsManifest } from '../../../passkit/types.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { crc32, sha1Hex } from './package/hash.ts';
import { generatedSource, syncBakedTemplates } from './sync.ts';
import { fakeAssets } from './testing.ts';

const ORIGIN = 'https://wallet.test';

function decodeDataUrl(data: string): Uint8Array {
  if (!data.startsWith('data:') || !data.includes(';base64,'))
    throw new Error('Baked fixture is not an inlined asset.');
  return Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0));
}

/** The generated baked packages' files, as the Worker's static assets. */
async function bakedAssets() {
  const assets = fakeAssets();
  // Workerd has no filesystem; Vite embeds the source bytes used to build the baked index.
  const files = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  const manifests = import.meta.glob<{ stamps?: StampsManifest }>(
    '../../../../templates/*/wallet.template.json',
    { eager: true, import: 'default' },
  );
  // The Stamp card's strips are drawn by `npm run gen` into public/ (not in git); draw them here.
  const drawn = new Map<string, Uint8Array>();
  for (const [file, manifest] of Object.entries(manifests)) {
    if (!manifest.stamps) continue;
    const slug = file.split('/').at(-2) as string;
    const prefix = `../../../../templates/${slug}/`;
    const inputs: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files))
      if (path.startsWith(prefix)) inputs[path.slice(prefix.length)] = decodeDataUrl(data);
    for (const strip of renderStampFiles(manifest.stamps, inputs).strips)
      drawn.set(`${slug}/${strip.name}`, strip.bytes);
  }
  const bytesFor = (slug: string, name: string) => {
    const strip = drawn.get(`${slug}/${name}`);
    if (strip) return strip;
    const data = files[`../../../../templates/${slug}/${name}`];
    if (!data) throw new Error(`Missing baked fixture bytes: ${slug}/${name}`);
    return decodeDataUrl(data);
  };
  for (const t of generatedSource.templates) {
    for (const a of t.assets) {
      const bytes = bytesFor(t.slug, a.name);
      if (bytes.length !== a.size || (await sha1Hex(bytes)) !== a.sha1 || crc32(bytes) !== a.crc32)
        throw new Error(`Baked fixture does not match generated metadata: ${t.slug}/${a.name}`);
      assets.files.set(a.source.path, bytes);
    }
    for (const extra of t.extras) assets.files.set(extra.path, bytesFor(t.slug, extra.name));
  }
  return assets;
}

export interface BlueprintKit {
  env: AppEnv;
  f: Fixtures;
  clock: ManualClock;
  org: { id: string };
  other: { id: string };
  henrys: { id: string };
  /** A platform administrator who is org admin of every org here. */
  admin: Record<string, string>;
  /** A session with these org roles in `orgId`. */
  member(
    orgId: string,
    roles: OrgRole[],
  ): Promise<{ userId: string; headers: Record<string, string> }>;
  call(
    path: string,
    init?: RequestInit,
    headers?: Record<string, string>,
  ): Promise<Response> | Response;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> | Response;
}

export async function blueprintKit(): Promise<BlueprintKit> {
  const clock = new ManualClock(Date.now());
  const env = await makeEnv({ ASSETS: await bakedAssets() });
  const f = fixtures(env, clock);
  const app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(env, clock) },
    clock,
  });
  const org = await makeOrg(f);
  const other = await makeOrg(f);
  const henrys = await makeOrg(f, { slug: 'henrys', name: 'Henry’s Gymnasium' });
  const join = async (userId: string, orgId: string, roles: OrgRole[]) => {
    const invitationId = f.ids.id();
    const now = clock.now();
    await run(
      env.DB,
      `INSERT INTO org_invitations
        (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
      [invitationId, orgId, JSON.stringify(roles), f.ids.token(), now, now + 3600_000, now, userId],
    );
    await run(
      env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [f.ids.id(), orgId, userId, invitationId, JSON.stringify(roles), now],
    );
  };
  const adminId = (await makeUser(f)).id;
  await join(adminId, org.id, ['org_admin']);
  await join(adminId, other.id, ['org_admin']);
  await join(adminId, henrys.id, ['org_admin']);
  const admin = (await makeSession(f, { userId: adminId, roles: ['admin', 'user'] })).headers;
  await syncBakedTemplates(createServiceContext(env, { clock }));
  const call = (path: string, init: RequestInit = {}, headers = admin) =>
    app.request(
      `${ORIGIN}/api/v1/templates${path}`,
      { ...init, headers: { ...headers, ...init.headers } },
      env,
    );
  return {
    env,
    f,
    clock,
    org,
    other,
    henrys,
    admin,
    async member(orgId, roles) {
      const userId = (await makeUser(f)).id;
      await join(userId, orgId, roles);
      return { userId, headers: (await makeSession(f, { userId, roles: ['user'] })).headers };
    },
    call,
    post: (path, body, headers = admin) =>
      call(
        path,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        },
        headers,
      ),
  };
}
