// The shared Google class carries a coupon's constant terms; paper and Samsung keep the full per-pass details.
import { beforeAll, describe, expect, it } from 'vitest';
import { planPass } from '../build.ts';
import { bakedBehaviors, loadBaked } from '../template/baked-fixtures.ts';
import { DERIVED_PAPER } from '../template/paper.ts';
import { blueprintPass, SCAN_CODE } from '../template/paper-blueprint-fixtures.ts';
import { paperContent } from '../template/paper-content.ts';
import { FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { SigningMaterial, TemplateManifest } from '../types.ts';
import { googleCompiler } from './google/compilers.ts';
import { APP, compile, imageUrl, NOW } from './samsung/fixtures.ts';
import { resolveWalletView } from './view.ts';

const SLUGS = ['starter-coupon', 'starter-pack'] as const;
const OVER = { message: 'Closed Monday', note: 'Bring this card', website: 'https://shop.example' };

beforeAll(async () => {
  for (const slug of SLUGS) await loadBaked(slug);
}, 120_000);

/** The manifest as it was before the Google class change: no `finePrint` role, no class key. */
const before = (manifest: TemplateManifest): TemplateManifest => {
  const { roles: _roles, ...wallets } = manifest.wallets as Record<string, unknown>;
  const google = { ...(wallets.google as object), classKey: undefined };
  return { ...manifest, wallets: { ...wallets, google } } as TemplateManifest;
};

async function viewFor(slug: string, over: object, original: boolean) {
  const { template, registry } = await loadBaked(slug);
  const input = { ...template.manifest.sample, ...over };
  const plan = planPass({
    template,
    registry,
    input,
    server: {
      serial: 'SERIAL',
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: 'Org',
      identity: FIXTURE_IDENTITY,
      scanCode: 'SNAPSHOT-SCAN-CODE',
    },
    signing: {} as SigningMaterial,
    behaviors: bakedBehaviors,
    now: NOW,
  });
  const manifest = original ? before(template.manifest) : template.manifest;
  return resolveWalletView(plan, manifest, {
    now: NOW,
    timeZone: 'UTC',
    locales: ['en'],
    input,
    assets: template.assets,
    assetUrl: imageUrl,
    appLink: APP,
  });
}

describe.each(SLUGS)('%s with a message, a note and a website', (slug) => {
  it('prints the same coupon as before', async () => {
    const { passJson, manifest, personalization } = await blueprintPass(slug, OVER);
    const read = (m: TemplateManifest) =>
      paperContent({
        passJson,
        manifest: m,
        personalization,
        design: DERIVED_PAPER,
        holderName: 'Fallback Name',
        scanCode: SCAN_CODE,
      });
    expect(read(manifest)).toEqual(read(before(manifest)));
  });

  it('gives Samsung the same card as before', async () => {
    const now = compile(await viewFor(slug, OVER, false));
    const then = compile(await viewFor(slug, OVER, true));
    expect(now.cardData).toEqual(then.cardData);
    // The terms are reported under their own role now; nothing else in the report moves.
    expect(now.items.filter((i) => i.capability !== 'role.finePrint')).toEqual(then.items);
  });

  it('puts the constant terms on the Google class and the per-pass text on the object', async () => {
    const options = { now: NOW, omit: [] };
    const a = googleCompiler.compile(await viewFor(slug, OVER, false), options);
    const b = googleCompiler.compile(await viewFor(slug, {}, false), options);
    expect(a.classBody).toEqual(b.classBody);
    expect(a.classBody).toMatchObject({ finePrint: expect.any(String) });
    expect(a.classBody).not.toHaveProperty('details');
    const modules = JSON.stringify((a as { objectBody: unknown }).objectBody);
    for (const text of Object.values(OVER)) expect(modules).toContain(text);
  });
});
