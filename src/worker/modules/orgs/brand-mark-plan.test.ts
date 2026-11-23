import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type {
  OrgEntitlementsDto,
  SetOrgEntitlementsInput,
} from '../../../shared/contracts/entitlement-admin.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { effectiveMark, marksOf } from './brand-mark.ts';

const fake = fakeAuth();
let rk: RetentionKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  rk = await retentionKit();
  fake.bindSessions(rk.kit.env.DB, rk.kit.clock);
  app = createApp({ stores: fake.stores, clock: rk.kit.clock });
}, 30_000);

async function org(mark: string | null) {
  const admin = await rk.org(['org_admin']);
  const root = await rk.platform();
  const headers = fake.session({ userId: root.userId, roles: ['admin', 'user'] });
  if (mark)
    await run(rk.kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ mark }),
      admin.orgId,
    ]);
  return { orgId: admin.orgId, headers };
}
const path = (orgId: string) => `/api/v1/platform/orgs/${orgId}/entitlements`;
async function plan(
  o: { orgId: string; headers: Record<string, string> },
  body: Partial<SetOrgEntitlementsInput>,
) {
  const read = (await (
    await app.request(path(o.orgId), { headers: o.headers }, rk.kit.env)
  ).json()) as OrgEntitlementsDto;
  const res = await app.request(
    path(o.orgId),
    {
      method: 'PUT',
      headers: { ...o.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: read.revision,
        preset: 'legacy',
        overrides: {},
        ...body,
      }),
    },
    rk.kit.env,
  );
  expect(res.status).toBe(200);
}
const stored = async (orgId: string) =>
  JSON.parse(
    (
      await first<{ b: string }>(rk.kit.env.DB, 'SELECT branding AS b FROM orgs WHERE id = ?', [
        orgId,
      ])
    )?.b ?? '{}',
  ).mark;

describe('marksOf and effectiveMark', () => {
  it('reads the least a plan shows, failing closed to full', () => {
    expect(marksOf('full')).toEqual(['full']);
    expect(marksOf('quiet')).toEqual(['small', 'full']);
    expect(marksOf('none')).toEqual(['none', 'small', 'full']);
    expect(marksOf(undefined)).toEqual(['full']);
    expect(marksOf('bogus')).toEqual(['full']);
    expect(marksOf(1)).toEqual(['full']);
  });

  it('falls to the nearest allowed mark with more PassBook', () => {
    expect(effectiveMark('none', ['small', 'full'])).toBe('small');
    expect(effectiveMark('none', ['full'])).toBe('full');
    expect(effectiveMark('small', ['full'])).toBe('full');
    expect(effectiveMark('small', ['none', 'small', 'full'])).toBe('small');
    expect(effectiveMark(undefined, ['none', 'small', 'full'])).toBe('full');
  });
});

describe('plan change moves a footer choice the plan no longer allows', () => {
  it('none falls to small on a quiet plan, and a fitting choice is left alone', async () => {
    const o = await org('none');
    await plan(o, { preset: 'standard' });
    expect(await stored(o.orgId)).toBe('small');
    await plan(o, { preset: 'standard', overrides: { 'brand.mark': { value: 'none' } } });
    // Allowed again, but the earlier fall back stands: nothing is restored.
    expect(await stored(o.orgId)).toBe('small');
  });

  it('small falls to full when the plan allows only full, and an unset choice stays unset', async () => {
    const o = await org('small');
    await plan(o, { preset: 'trial' });
    expect(await stored(o.orgId)).toBe('full');
    const unset = await org(null);
    await plan(unset, { preset: 'trial' });
    expect(await stored(unset.orgId)).toBeUndefined();
  });

  it('keeps a choice that still fits', async () => {
    const o = await org('small');
    await plan(o, { preset: 'standard' });
    expect(await stored(o.orgId)).toBe('small');
  });
});
