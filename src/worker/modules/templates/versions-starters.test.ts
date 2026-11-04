import { expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { makePng } from './package/fixtures.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets } from './testing.ts';

const SLUGS = [
  'generic',
  'coupon',
  'event-ticket',
  'store-card',
  'boarding-pass',
  'poster-generic',
];

it('a duplicate of every starter opens in the designer without errors, and saves', async () => {
  const clock = new ManualClock(Date.now());
  const assets = fakeAssets();
  for (const t of generatedSource.templates)
    for (const a of t.assets)
      assets.files.set(
        a.source.path,
        a.name.endsWith('.png')
          ? makePng(a.width ?? 38, a.height ?? 38)
          : new TextEncoder().encode('"a" = "b";\n'),
      );
  const env = await makeEnv({ ASSETS: assets });
  const auth = fakeAuth('https://wallet.test');
  const app = createApp({ stores: auth.stores });
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  const admin = auth.session({ userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
  const call = (path: string, body?: unknown) =>
    app.request(
      `https://wallet.test/api/v1/templates${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const results: Record<string, unknown> = {};
  for (const slug of SLUGS) {
    const clone = await call(`/baked:starter-${slug}/clone`, {
      orgId: org.id,
      name: `Copy ${slug}`,
    });
    const { id } = (await clone.json()) as { id: string };
    const { activeVersion } = (await (await call(`/${id}`)).json()) as { activeVersion: string };
    const v = (await (await call(`/${id}/versions/${activeVersion}`)).json()) as {
      passJson: unknown;
      manifest: unknown;
      assets: { name: string; sha1: string }[];
    };
    const draft = {
      passJson: v.passJson,
      manifest: v.manifest,
      assets: v.assets.map(({ name, sha1 }) => ({ name, sha1 })),
    };
    const res = await call(`/${id}/versions`, { ...draft, dryRun: true });
    const body = (await res.json()) as {
      report: { issues: { severity: string; code: string }[] };
      passJson: unknown;
    };
    results[slug] = [
      res.status,
      body.report.issues.filter((i) => i.severity === 'error'),
      body.passJson !== null,
    ];
    if (slug === 'generic') {
      const saved = await call(`/${id}/versions`, draft);
      expect(await saved.json()).toMatchObject({ saved: true, activated: false });
    }
  }
  expect(results).toEqual(Object.fromEntries(SLUGS.map((s) => [s, [200, [], true]])));
}, 60_000);
