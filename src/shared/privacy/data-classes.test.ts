import { describe, expect, it } from 'vitest';
import { OrgSettingsSchema, PlatformSettingsSchema } from '../contracts/settings.ts';
import {
  DATA_CLASSES,
  isRetentionClass,
  isValidDays,
  ON_EXPIRY_TEXT,
  RETENTION_CLASSES,
} from './data-classes.ts';

describe('data class table', () => {
  it.each(RETENTION_CLASSES)('%s: floor <= default <= platform max <= ceiling', (cls) => {
    const c = DATA_CLASSES[cls];
    expect(c.cls).toBe(cls);
    expect(c.floor).toBeGreaterThanOrEqual(1);
    expect(c.platformDefault).toBeGreaterThanOrEqual(c.floor);
    expect(c.platformDefault).toBeLessThanOrEqual(c.platformMax);
    expect(c.platformMax).toBeLessThanOrEqual(c.ceiling);
    expect(c.label).not.toBe('');
    expect(c.holds).not.toBe('');
    expect(ON_EXPIRY_TEXT[c.onExpiry]).toBeTruthy();
  });

  it('keys follow the class name', () => {
    for (const cls of RETENTION_CLASSES) {
      expect(DATA_CLASSES[cls].key).toBe(`retention.${cls}Days`);
      expect(DATA_CLASSES[cls].maxKey).toBe(`retention.${cls}MaxDays`);
    }
  });

  it('matches the design bounds', () => {
    const bounds = Object.fromEntries(
      RETENTION_CLASSES.map((c) => [c, [DATA_CLASSES[c].floor, DATA_CLASSES[c].ceiling]]),
    );
    expect(bounds).toEqual({
      scans: [30, 3650],
      events: [7, 3650],
      visitors: [1, 400],
      delivery: [7, 90],
      photos: [1, 400],
      imports: [1, 90],
      webhooks: [1, 30],
    });
  });

  it('isValidDays accepts whole days inside the bounds only', () => {
    expect(isValidDays('scans', 30)).toBe(true);
    expect(isValidDays('scans', 29)).toBe(false);
    expect(isValidDays('scans', 3650)).toBe(true);
    expect(isValidDays('scans', 3651)).toBe(false);
    for (const v of [1.5, '30', null, undefined, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isValidDays('scans', v)).toBe(false);
    expect(isRetentionClass('scans')).toBe(true);
    expect(isRetentionClass('audit')).toBe(false);
  });
});

describe('settings schemas read the table', () => {
  it.each(RETENTION_CLASSES)('%s: org, platform default and platform max bounds', (cls) => {
    const c = DATA_CLASSES[cls];
    const org = OrgSettingsSchema.shape[c.key];
    const def = PlatformSettingsSchema.shape[c.key];
    const max = PlatformSettingsSchema.shape[c.maxKey];
    for (const schema of [org, def, max]) {
      expect(schema.safeParse(c.floor).success).toBe(true);
      expect(schema.safeParse(c.floor - 1).success).toBe(false);
      expect(schema.safeParse(c.ceiling).success).toBe(true);
      expect(schema.safeParse(c.ceiling + 1).success).toBe(false);
      expect(schema.safeParse(c.floor + 0.5).success).toBe(false);
    }
    expect(org.safeParse(undefined).success).toBe(true);
    expect(PlatformSettingsSchema.parse({})[c.key]).toBe(c.platformDefault);
    expect(PlatformSettingsSchema.parse({})[c.maxKey]).toBe(c.platformMax);
    expect(OrgSettingsSchema.parse({})[c.key]).toBeUndefined();
  });

  it('audit retention cannot go under 365 days and is not an org setting', () => {
    expect(PlatformSettingsSchema.shape['retention.auditDays'].safeParse(364).success).toBe(false);
    expect(PlatformSettingsSchema.shape['retention.auditDays'].safeParse(365).success).toBe(true);
    expect('retention.auditDays' in OrgSettingsSchema.shape).toBe(false);
  });

  it('org privacy contacts validate', () => {
    const s = OrgSettingsSchema.shape;
    expect(s['privacy.email'].safeParse('privacy@x.example').success).toBe(true);
    expect(s['privacy.email'].safeParse('nope').success).toBe(false);
    expect(s['privacy.url'].safeParse('https://x.example/privacy').success).toBe(true);
    expect(s['privacy.url'].safeParse('http://x.example').success).toBe(false);
    expect(s['privacy.legalName'].safeParse('Acme\nLtd').success).toBe(false);
  });
});
