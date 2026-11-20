import { describe, expect, it } from 'vitest';
import { PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import { inherit, platformGateIssue, type SettingEntry } from './inherit.ts';

const platform = PlatformSettingsSchema.parse({});
const entry = (value: number, source: 'org' | 'default' = 'org'): SettingEntry => ({
  scope: 'org:x',
  key: 'email.orgCapPerDay',
  value,
  default: platform['email.orgCapPerDayMax'],
  source,
  updatedAt: null,
  updatedBy: null,
});
const read = (e: SettingEntry, plan: Parameters<typeof inherit>[2]) =>
  inherit([e], platform, plan)[0];

describe('the plan clamps the org email cap', () => {
  it('lowers the ceiling to the plan, for a stored value and the default', () => {
    const plan = { 'email.perDay': 100 };
    expect(read(entry(500), plan)).toMatchObject({ value: 100, ceiling: 100, default: 100 });
    expect(read(entry(0, 'default'), plan)).toMatchObject({ value: 100, ceiling: 100 });
  });

  it('leaves the platform maximum when the plan has no cap, and keeps the stored value', () => {
    const max = platform['email.orgCapPerDayMax'];
    expect(read(entry(300), { 'email.perDay': null })).toMatchObject({ value: 300, ceiling: max });
    expect(read(entry(300), {})).toMatchObject({ value: 300, ceiling: max });
  });

  it('refuses an org write above the plan, and one at the plan passes', () => {
    const plan = { 'email.perDay': 100 };
    expect(platformGateIssue(platform, { 'email.orgCapPerDay': 101 }, plan)).toMatchObject({
      code: 'ORG_CAP_ABOVE_MAX',
      message: 'Up to 100.',
    });
    expect(platformGateIssue(platform, { 'email.orgCapPerDay': 100 }, plan)).toBeNull();
    expect(
      platformGateIssue(platform, { 'email.orgCapPerDay': 101 }, { 'email.perDay': null }),
    ).toBeNull();
  });
});
