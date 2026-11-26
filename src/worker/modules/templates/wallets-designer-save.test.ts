/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
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
import type { DesignDoc } from '../../../web/admin/templates/designer/model.ts';
import {
  applyWalletsOp,
  readWallets,
  type WalletsOp,
} from '../../../web/admin/templates/designer/wallets/ops-wallets.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets } from './testing.ts';

const SLUG = 'starter-store-card';
const source = generatedSource.templates.find((t) => t.slug === SLUG);
if (!source) throw new Error('The Store card is missing; run npm run gen.');

let call: (path: string, init?: { body?: unknown; method?: string }) => Promise<Response>;
let cloneId = '';
let logoBase64 = '';

beforeAll(async () => {
  const clock = new ManualClock();
  const assets = fakeAssets();
  const files = import.meta.glob<string>(
    '../../../../templates/starter-store-card/**/*.{png,strings}',
    {
      eager: true,
      query: '?url&inline',
      import: 'default',
    },
  );
  const bytesOf = (name: string) => {
    const data = files[`../../../../templates/${SLUG}/${name}`];
    if (!data?.includes(';base64,')) throw new Error(`Missing source ${name}`);
    return { base64: data.slice(data.indexOf(',') + 1), data };
  };
  for (const a of source.assets) {
    const { base64 } = bytesOf(a.name);
    assets.files.set(
      a.source.path,
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
    );
  }
  logoBase64 = bytesOf('wallets/google/logo.png').base64;
  const env: AppEnv = await makeEnv({ ASSETS: assets });
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
  const clone = await call(`/baked:${SLUG}/clone`, { body: { orgId: org.id, name: 'Store' } });
  if (clone.status !== 201) throw new Error(`Clone failed: ${clone.status}`);
  cloneId = TemplateDetailSchema.parse(await clone.json()).id;
});

async function baseDoc(): Promise<DesignDoc> {
  const detail = TemplateDetailSchema.parse(await (await call(`/${cloneId}`)).json());
  const v = TemplateVersionDetailSchema.parse(
    await (await call(`/${cloneId}/versions/${detail.versions[0]?.version}`)).json(),
  );
  return {
    passJson: v.passJson as DesignDoc['passJson'],
    manifest: v.manifest as DesignDoc['manifest'],
    assets: v.assets.map((a) => ({
      name: a.name,
      slot: a.slot,
      scale: a.scale,
      size: a.size,
      sha1: a.sha1,
    })),
  };
}

const dryRun = async (doc: DesignDoc) => {
  const body = {
    passJson: doc.passJson,
    manifest: doc.manifest,
    dryRun: true,
    assets: doc.assets.map((a) =>
      a.upload !== undefined
        ? { name: a.name, upload: a.upload }
        : { name: a.name, sha1: a.sha1 ?? '' },
    ),
  };
  return SaveVersionResponseSchema.parse(
    await (await call(`/${cloneId}/versions`, { body })).json(),
  );
};

const OPS: WalletsOp[] = [
  { op: 'wallets-role', role: 'tier', source: { field: 'tier' } },
  { op: 'wallets-role', role: 'title', source: false },
  {
    op: 'wallets-roles',
    sources: { memberId: { value: '{{name}}' }, points: { field: 'points' } },
  },
  { op: 'wallets-type', target: 'google', type: 'loyalty' },
  { op: 'wallets-type', target: 'samsung', type: 'ticket' },
  { op: 'wallets-subtype', subType: 'entrances' },
  { op: 'wallets-class-key', expr: '{{name|url}}' },
  { op: 'wallets-omit', target: 'samsung', entry: 'backFields.terms', on: true },
  { op: 'wallets-omit', target: 'google', entry: 'sharing', on: true },
  { op: 'wallets-required', id: 'type', on: true },
  { op: 'wallets-required', id: 'role.memberId', on: true },
  {
    op: 'wallets-image',
    target: 'samsung',
    slot: 'logo',
    asset: {
      name: '',
      slot: 'source',
      scale: 1,
      size: 46009,
      width: 660,
      height: 660,
      upload: 'LOGO',
    },
  },
];

describe('the Wallets tab saves what the server accepts', () => {
  it('validates every op with no WALLETS_ or WALLET_ART_ issue', async () => {
    let doc = await baseDoc();
    for (const raw of OPS) {
      const op =
        raw.op === 'wallets-image'
          ? { ...raw, asset: raw.asset && { ...raw.asset, upload: logoBase64 } }
          : raw;
      doc = applyWalletsOp(doc, op);
      const res = await dryRun(doc);
      const bad = res.report.issues.filter(
        (i) => /^WALLET(S|_ART)_/.test(i.code) && i.severity === 'error',
      );
      expect(bad, JSON.stringify(op)).toEqual([]);
    }
  });

  it('leaves the wallets block as it was when an op changes nothing', async () => {
    const doc = await baseDoc();
    const again = applyWalletsOp(doc, { op: 'wallets-required', id: 'type', on: false });
    // An empty `samsung: {}` is dropped; everything else stays.
    expect(readWallets(again)).toEqual({
      schema: 1,
      google: { images: { logo: 'wallets/google/logo.png' } },
    });
    expect((await dryRun(doc)).report.issues.filter((i) => i.code.startsWith('WALLET'))).toEqual(
      [],
    );
  });
});
