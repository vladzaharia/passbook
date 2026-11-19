import type { z } from 'zod';
import type { PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import { DATA_CLASSES, RETENTION_CLASSES } from '../../../shared/privacy/data-classes.ts';

type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;

export interface SettingEntry {
  scope: string;
  key: string;
  value: unknown;
  default?: unknown;
  source: 'org' | 'default';
  ceiling?: number;
  blockedByPlatform?: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
}

const clamp = (n: number, max: number) => Math.min(n, max);

/** Org entries read through the platform: defaults come from it and values stop at its ceilings. */
export function inherit(entries: SettingEntry[], platform: PlatformSettings): SettingEntry[] {
  const retention = new Map(
    RETENTION_CLASSES.map((cls) => [DATA_CLASSES[cls].key as string, DATA_CLASSES[cls]]),
  );
  return entries.map((entry) => {
    const cls = retention.get(entry.key);
    if (cls) {
      const ceiling = platform[cls.maxKey];
      const fallback = clamp(Math.max(platform[cls.key], cls.floor), ceiling);
      const value =
        entry.source === 'org' && typeof entry.value === 'number'
          ? clamp(Math.max(entry.value, cls.floor), ceiling)
          : fallback;
      return { ...entry, value, default: fallback, ceiling };
    }
    if (entry.key === 'email.orgCapPerDay') {
      const ceiling = platform['email.orgCapPerDayMax'];
      const fallback = clamp(entry.default as number, ceiling);
      return {
        ...entry,
        value: entry.source === 'org' ? clamp(entry.value as number, ceiling) : fallback,
        default: fallback,
        ceiling,
      };
    }
    if (entry.key === 'nfc.tags' && !platform['nfc.enabled'])
      return { ...entry, blockedByPlatform: true };
    return entry;
  });
}

/** An org write the platform's switches or ceilings refuse, or null. */
export function platformGateIssue(
  platform: PlatformSettings,
  upserts: Record<string, unknown>,
): { path: string; message: string; code: string } | null {
  const tags = upserts['nfc.tags'] as { enabled?: boolean } | undefined;
  if (tags?.enabled === true && !platform['nfc.enabled'])
    return { path: 'nfc.tags', message: 'NFC is off for all organizations.', code: 'NFC_OFF' };
  const cap = upserts['email.orgCapPerDay'];
  const max = platform['email.orgCapPerDayMax'];
  if (typeof cap === 'number' && cap > max)
    return { path: 'email.orgCapPerDay', message: `Up to ${max}.`, code: 'ORG_CAP_ABOVE_MAX' };
  return null;
}
