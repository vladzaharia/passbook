import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { PassJson, SigningMaterial } from '../types.ts';
import { accessIssues } from './access/index.ts';
import { bakedSlugs, buildBaked, freezeNow, loadBaked } from './baked-fixtures.ts';
import { pngSize } from './package.ts';
import { ScanDisplayDocSchema } from './scan-display/schema.ts';
import { scanDisplayIssues } from './scan-display/validate.ts';

const SLUGS = [
  'starter-multi-day-pass',
  'starter-hotel-stay',
  'starter-credential',
  'starter-staff-badge',
  'starter-visitor-pass',
] as const;

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
}, 60_000);

describe.each(SLUGS)('%s', (slug) => {
  it('is a blueprint with wallets and Google art', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const m = template.manifest;
    expect(m.blueprint).toBe(true);
    expect(m.wallets?.schema).toBe(1);
    expect(m.wallets?.samsung).toEqual({});
    const wallets = m.wallets as unknown as { google: { images: Record<string, string> } };
    const images = wallets.google.images;
    for (const file of Object.values(images)) {
      const size = pngSize(
        new Uint8Array(readFileSync(join(import.meta.dirname, '../../../templates', slug, file))),
      );
      expect(size?.width).toBe(file.endsWith('logo.png') ? 660 : 1860);
    }
  });

  it('has a valid scan display with no warnings', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const m = template.manifest;
    expect(accessIssues(m)).toEqual([]);
    expect(() => ScanDisplayDocSchema.parse(m.scan?.display)).not.toThrow();
    expect(scanDisplayIssues(m, { passJson: template.passJson as PassJson })).toEqual([]);
  });

  it('builds and validates the sample', async () => {
    const built = await buildBaked(slug, material);
    const issues = built.report.issues.filter(
      (i) => i.severity !== 'info' && i.code !== 'BACK_CONTACT' && i.code !== 'PET_NFC',
    );
    expect(issues).toEqual([]);
  });
});

describe('second set specifics', () => {
  it('lists every new slug', () => {
    for (const slug of SLUGS) expect(bakedSlugs()).toContain(slug);
  });

  it('Visitor is one guest plan for the day, with the host for the desk only', async () => {
    const { template } = await loadBaked('starter-visitor-pass', { strips: false });
    const [plan] = template.manifest.scan?.access?.plans ?? [];
    expect(plan).toMatchObject({ kind: 'guest', days: 1 });
    expect(template.manifest.scan?.flags).toEqual([{ input: 'checkId', label: 'Check ID' }]);
    expect(JSON.stringify(template.manifest.scan?.display)).toContain('"minRole":"desk"');
  });

  it('Visitor takes loaner tags only and holds no host email', async () => {
    const { template } = await loadBaked('starter-visitor-pass', { strips: false });
    const m = template.manifest;
    // A member-use tag fails the `uses` check of the bind policy (TAG_USE_MISMATCH).
    expect(m.scan?.tags?.uses).toEqual(['visitor']);
    expect(Object.keys(m.inputs?.properties ?? {})).not.toContain('hostEmail');
    expect(Object.keys(m.sample ?? {})).not.toContain('hostEmail');
    expect(m.scan?.access?.input?.sponsor).toBe('sponsor');
  });

  it('Staff badge has staff, shift and contractor plans and suspends on leave', async () => {
    const { template } = await loadBaked('starter-staff-badge', { strips: false });
    const access = template.manifest.scan?.access;
    expect(access?.plans.map((p) => [p.id, p.kind])).toEqual([
      ['staff', 'always'],
      ['shift', 'timed'],
      ['contractor', 'guest'],
    ]);
    expect(access?.suspend?.equals).toEqual(['On leave', 'Suspended']);
  });

  it('Credential puts the verify link in the QR when given, else the scan code', async () => {
    const { template } = await loadBaked('starter-credential', { strips: false });
    const base = { ...template.manifest.sample };
    const plain = await buildBaked('starter-credential', material, base);
    const linked = await buildBaked('starter-credential', material, {
      ...base,
      verifyUrl: 'https://verify.example/77310',
    });
    expect(plain.passJson.barcodes?.[0]?.message).not.toContain('https://');
    expect(linked.passJson.barcodes?.[0]?.message).toBe('https://verify.example/77310');
  });

  it('Credential voids when revoked', async () => {
    const { template } = await loadBaked('starter-credential', { strips: false });
    const built = await buildBaked('starter-credential', material, {
      ...template.manifest.sample,
      status: 'Revoked',
    });
    expect(built.passJson.voided).toBe(true);
  });

  it('Multi-day takes add-ons once and flags a missing wristband', async () => {
    const { template } = await loadBaked('starter-multi-day-pass', { strips: false });
    const actions = template.manifest.scan?.actions ?? [];
    expect(actions.map((a) => [a.id, a.kind])).toEqual([
      ['check_in', 'check_in'],
      ['parking', 'take'],
      ['locker', 'take'],
      ['wristband', 'set'],
    ]);
    expect(template.manifest.scan?.flags?.[0]?.label).toBe('No wristband yet');
  });
});
