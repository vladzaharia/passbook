import type { z } from 'zod';
import { blockedByEntitlement } from '../../../shared/channels.ts';
import type { Channel } from '../../../shared/contracts/channels.ts';
import { entitledValue } from '../../../shared/contracts/entitlements.ts';
import type { PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import { DATA_CLASSES, RETENTION_CLASSES } from '../../../shared/privacy/data-classes.ts';
import type { Entitlements } from '../../platform/entitlements.ts';

type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;

export interface SettingEntry {
  scope: string;
  key: string;
  value: unknown;
  default?: unknown;
  source: 'org' | 'default';
  ceiling?: number;
  blockedByPlatform?: boolean;
  blockedByPlan?: boolean;
  planBlocked?: Channel[];
  updatedAt: number | null;
  updatedBy: string | null;
}

const clamp = (n: number, max: number) => Math.min(n, max);

/** The platform's daily email maximum, lowered to the plan's `email.perDay`; a missing value allows none, as at send. */
export function emailCeiling(platform: PlatformSettings, entitlements: Entitlements): number {
  const plan = entitlements['email.perDay'];
  const max = platform['email.orgCapPerDayMax'];
  return plan === null ? max : Math.min(max, typeof plan === 'number' ? plan : 0);
}

/** NFC tags need the plan's `nfc` at least Basic. */
const nfcIncluded = (entitlements: Entitlements) => entitledValue('nfc', entitlements.nfc, 'basic');

/**
 * Org entries read through the platform and the plan: defaults come from the platform and values stop at its
 * ceilings; a setting whose feature the plan lacks reads `blockedByPlan`.
 */
export function inherit(
  entries: SettingEntry[],
  platform: PlatformSettings,
  entitlements: Entitlements,
): SettingEntry[] {
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
      const ceiling = emailCeiling(platform, entitlements);
      const fallback = clamp(entry.default as number, ceiling);
      return {
        ...entry,
        value: entry.source === 'org' ? clamp(entry.value as number, ceiling) : fallback,
        default: fallback,
        ceiling,
      };
    }
    if (entry.key === 'channels.blocked') {
      const planBlocked = Object.keys(blockedByEntitlement(entitlements)) as Channel[];
      return planBlocked.length > 0 ? { ...entry, planBlocked } : entry;
    }
    if (entry.key === 'nfc.tags')
      return {
        ...entry,
        ...(platform['nfc.tagsEnabled'] ? {} : { blockedByPlatform: true }),
        ...(nfcIncluded(entitlements) ? {} : { blockedByPlan: true }),
      };
    return entry;
  });
}

/** The feature an org write needs that the plan lacks (`FEATURE_NOT_INCLUDED`), or null. */
export function planGateIssue(
  entitlements: Entitlements,
  upserts: Record<string, unknown>,
  deletes: readonly string[] = [],
): { key: 'nfc' } | null {
  const tags = upserts['nfc.tags'] as { enabled?: boolean } | undefined;
  // A reset reads as the default, which is on: it turns the setting on as much as writing it does.
  const on = tags?.enabled === true || deletes.includes('nfc.tags');
  return on && !nfcIncluded(entitlements) ? { key: 'nfc' } : null;
}

/** An org write the platform's switches or ceilings refuse, or null. */
export function platformGateIssue(
  platform: PlatformSettings,
  upserts: Record<string, unknown>,
  entitlements?: Entitlements,
): { path: string; message: string; code: string } | null {
  const tags = upserts['nfc.tags'] as { enabled?: boolean } | undefined;
  if (tags?.enabled === true && !platform['nfc.tagsEnabled'])
    return {
      path: 'nfc.tags',
      message: 'NFC tags are off for all organizations.',
      code: 'NFC_OFF',
    };
  const cap = upserts['email.orgCapPerDay'];
  const max = entitlements
    ? emailCeiling(platform, entitlements)
    : platform['email.orgCapPerDayMax'];
  if (typeof cap === 'number' && cap > max)
    return { path: 'email.orgCapPerDay', message: `Up to ${max}.`, code: 'ORG_CAP_ABOVE_MAX' };
  return null;
}
