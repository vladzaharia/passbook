import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import type { OrgEntitlementsDto } from '../../../shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_PRESETS, presetValues } from '../../../shared/contracts/entitlements.ts';
import { createApp } from '../../app.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { type Api, BASE, GOOD, setupApi } from '../webhooks/api-test-fixtures.ts';
import { stubNet } from '../webhooks/deliver-test-fixtures.ts';

const fake = fakeAuth();
let rk: RetentionKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  rk = await retentionKit();
  fake.bindSessions(rk.kit.env.DB, rk.kit.clock);
  app = createApp({ stores: fake.stores, clock: rk.kit.clock });
}, 30_000);

const root = async () => {
  const r = await rk.platform();
  return fake.session({ userId: r.userId, roles: ['admin', 'user'] });
};
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    rk.kit.env,
  );
const entPath = (orgId: string) => `/api/v1/platform/orgs/${orgId}/entitlements`;

describe('an org created on each preset', () => {
  it.each(ENTITLEMENT_PRESETS.filter((p) => p !== 'developer'))(
    'holds the %s values',
    async (preset) => {
      const org = await makeOrg(rk.kit.fx, { preset });
      expect(await entitlementsOf(rk.kit.ctx, org.id)).toEqual(presetValues(preset));
    },
  );
});

describe('the footer rule', () => {
  it('refuses brand.mark none on Admit One with FOOTER_REQUIRED, in an org save and in the preset editor', async () => {
    const admin = await root();
    const org = await makeOrg(rk.kit.fx, { preset: 'standard' });
    const read = (await (await send('GET', entPath(org.id), admin)).json()) as OrgEntitlementsDto;
    const res = await send('PUT', entPath(org.id), admin, {
      expectedRevision: read.revision,
      preset: 'starter',
      overrides: { 'brand.mark': { value: 'none', note: null, expiresAt: null } },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('FOOTER_REQUIRED');
    const ok = await send('PUT', entPath(org.id), admin, {
      expectedRevision: read.revision,
      preset: 'starter',
      overrides: {},
    });
    expect(ok.status).toBe(200);

    const presets = (await (
      await send('GET', '/api/v1/platform/entitlement-presets', admin)
    ).json()) as {
      presets: { preset: string; revision: number }[];
    };
    const starter = presets.presets.find((p) => p.preset === 'starter');
    const edit = await send('PUT', '/api/v1/platform/entitlement-presets', admin, {
      preset: 'starter',
      expectedRevision: starter?.revision,
      values: { 'brand.mark': 'none' },
    });
    expect(edit.status).toBe(422);
    expect(((await edit.json()) as { code: string }).code).toBe('FOOTER_REQUIRED');
  });

  it('allows it on Backstage', async () => {
    const admin = await root();
    const org = await makeOrg(rk.kit.fx, { preset: 'standard' });
    const read = (await (await send('GET', entPath(org.id), admin)).json()) as OrgEntitlementsDto;
    const res = await send('PUT', entPath(org.id), admin, {
      expectedRevision: read.revision,
      preset: 'business',
      overrides: {},
    });
    expect(res.status).toBe(200);
  });
});

describe('webhook endpoints on Backstage', () => {
  it('allows 15 and refuses the 16th by the plan', async () => {
    const api: Api = await setupApi();
    const net = stubNet();
    try {
      const orgId = (await makeOrg(api.rig.kit.fx, { preset: 'business' })).id;
      const admin = await api.member(['org_admin'], { orgId });
      for (let i = 0; i < 15; i++) {
        api.resetLimits();
        const res = await api.call(
          'POST',
          BASE,
          { orgId, ...GOOD, url: `https://hooks.example.com/${i}` },
          admin,
        );
        expect(res.status, `endpoint ${i + 1}`).toBe(201);
      }
      api.resetLimits();
      const over = await api.call(
        'POST',
        BASE,
        { orgId, ...GOOD, url: 'https://hooks.example.com/16' },
        admin,
      );
      expect(over.json.code).toBe('FEATURE_LIMIT_REACHED');
    } finally {
      net.restore();
    }
  }, 60_000);
});
