import { describe, expect, it } from 'vitest';
import { scanOf } from '../../shared/scan-defaults.ts';
import { loadBaked, stableJson } from './baked-fixtures.ts';
import { scanManifestIssues } from './scan.ts';

const SLUGS = [
  'starter-store-card',
  'starter-coupon',
  'starter-event-ticket',
  'starter-boarding-pass',
  'starter-generic',
  'starter-poster-generic',
  'starter-stamp-card',
  'starter-access-card',
  'starter-pack',
  'starter-timed-ticket',
  'starter-transit-ticket',
  'starter-booking',
  'starter-pickup',
  'starter-permit',
  'starter-id-card',
];

describe.each(SLUGS)('%s scan block', (slug) => {
  it('has no scan issues, not even warnings', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const issues = scanManifestIssues(template.manifest, { passJson: template.passJson });
    expect(issues).toEqual([]);
  });

  it('resolves to the shipped scan actions', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    await expect(stableJson(scanOf(template.manifest))).toMatchFileSnapshot(
      `__snapshots__/${slug}.scan.golden`,
    );
  });
});

describe.each(SLUGS)('%s scan screen', (slug) => {
  it('fits the density budget beside its own flags', async () => {
    const { template } = await loadBaked(slug, { strips: false });
    const issues = scanManifestIssues(template.manifest, { passJson: template.passJson });
    expect(issues.filter((i) => i.code === 'SCAN_DISPLAY_DENSITY')).toEqual([]);
  });
});

describe('blueprint scan blocks, by design', () => {
  const actions = async (slug: string) =>
    scanOf((await loadBaked(slug, { strips: false })).template.manifest).actions;

  it('charges the Balance card in whole-number presets', async () => {
    const [charge, topUp, set] = await actions('starter-store-card');
    expect(charge).toMatchObject({
      kind: 'take',
      input: 'balance',
      minRole: 'desk',
      confirm: true,
    });
    expect(charge?.amount).toEqual({ max: 500, presets: [5, 10, 20] });
    expect(topUp).toMatchObject({ kind: 'add', repeat: 'always' });
    expect(set).toMatchObject({ kind: 'set', minRole: 'manager' });
  });

  it('reads the Stamp card reward as the literal "Reward"', async () => {
    const [stamp, redeem] = await actions('starter-stamp-card');
    expect(stamp).toMatchObject({ repeat: 'cooldown', cooldownMinutes: 2 });
    expect(redeem?.rewardLabel).toBe('Reward');
  });

  it('puts the scan code in the Coupon barcode', async () => {
    const { template } = await loadBaked('starter-coupon', { strips: false });
    const message = template.manifest.bindings.find(
      (b) => 'barcode' in b.to && b.to.prop === 'message',
    );
    expect(message?.value).toBe('{{pass.scanCode}}');
  });
});
