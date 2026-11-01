import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { packagePassBytes } from '../package/zip.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { Personalization, SigningMaterial } from '../types.ts';
import {
  bakedBehaviors,
  bakedSlugs,
  buildBaked as build,
  freezeNow,
  loadBaked,
  stableJson,
} from './baked-fixtures.ts';
import { projectDisplay, validateManifest } from './manifest.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
});
const buildBaked = (slug: string, input?: Personalization) => build(slug, material, input);

describe.each(bakedSlugs())('baked template %s', (slug) => {
  it('has a valid manifest', async () => {
    const { template, pkg } = await loadBaked(slug);
    const issues = validateManifest(template.manifest, {
      allowPattern: true,
      passJson: template.passJson,
      behaviors: bakedBehaviors,
      assetNames: pkg.assets.map((a) => a.name),
    });
    expect(issues).toEqual([]);
  });

  it('builds, validates with no errors and signs the sample', async () => {
    const built = await buildBaked(slug);
    expect(built.report.ok).toBe(true);
    expect(built.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const files = unzipSync(packagePassBytes(built.signed));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['pass.json', 'manifest.json', 'signature', 'icon@2x.png']),
    );
    // Wallet devices are all @2x or @3x.
    expect(Object.keys(files).filter((n) => /^[A-Za-z]+\.png$/.test(n))).toEqual([]);
  });

  it('ships no designer ids, no wallet files and no hard-coded identity', async () => {
    const {
      template: { passJson },
    } = await loadBaked(slug);
    const text = JSON.stringify(passJson);
    expect(text).not.toContain('_id');
    expect(text).not.toContain('pass.com.henrysgymnasium');
    expect(passJson.passTypeIdentifier).toBeUndefined();
    expect(passJson.teamIdentifier).toBeUndefined();
    const built = await buildBaked(slug);
    const names = Object.keys(built.signed.files);
    expect(names).not.toEqual(expect.arrayContaining(['wallet.template.json']));
    expect(names).not.toContain('tooling.json');
  });

  it('is deterministic', async () => {
    const [a, b] = [await buildBaked(slug), await buildBaked(slug)];
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('projects display fields from the sample', async () => {
    const { template } = await loadBaked(slug);
    expect(projectDisplay(template.manifest, template.manifest.sample).title).not.toBe('');
  });

  it('matches the golden pass.json', async () => {
    const built = await buildBaked(slug);
    await expect(stableJson(built.passJson)).toMatchFileSnapshot(
      `__snapshots__/${slug}.sample.golden`,
    );
  });
});
