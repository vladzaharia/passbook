import { z } from 'zod';
import { strictEmail } from '../email.ts';
import { PlainLineSchema } from './common.ts';

export {
  SettingEntrySchema,
  SettingScopeSchema,
  SettingsImpactSchema,
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from './settings-list.ts';

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Notifying updates one pass may get per rolling 24 hours, until the setting is changed. */
export const PUSH_BUDGET_DEFAULT = 3;

export const PlatformSettingsSchema = z.object({
  'oidc.trustEmail': z.boolean().default(false),
  'auth.magicLinkEnabled': z.boolean().default(true),
  'email.senderName': PlainLineSchema(80).default('PassBook'),
  'refresh.userCooldownSeconds': z.number().int().min(5).max(3600).default(30),
  'retention.passVersionsKeep': z.number().int().min(1).max(50).default(3),
  'retention.auditDays': z.number().int().min(30).max(3650).default(365),
  /** Sync log and device activity (pass_events). */
  'retention.eventsDays': z.number().int().min(7).max(3650).default(90),
  /** Test-mode passes, bundles and captured emails older than this are deleted daily. */
  'sandbox.purgeDays': z.number().int().min(1).max(365).default(30),
  /** Notifying updates one pass may get per rolling 24 hours; later updates are silent. */
  'push.budgetPerDay': z.number().int().min(0).max(50).default(PUSH_BUDGET_DEFAULT),
  /** Scans older than this are deleted daily. */
  'retention.scansDays': z.number().int().min(30).max(3650).default(396),
  /** How long a scanner may undo its own scan. */
  'scan.undoWindowMinutes': z.number().int().min(1).max(60).default(10),
  /** Name and email lookups one scanner may run per hour. */
  'scan.lookupsPerHour': z.number().int().min(20).max(2000).default(200),
  /** Apple NFC (VAS). Off until Apple approves the pass type. */
  'nfc.enabled': z.boolean().default(false),
});
export const OrgSettingsSchema = z.object({
  'branding.accent': z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  'support.email': z
    .string()
    .max(254)
    .refine((v) => strictEmail(v) !== null, 'Enter a valid email address.')
    .optional(),
  'support.url': z
    .string()
    .max(500)
    .refine(isHttpsUrl, 'Use an https URL without credentials.')
    .optional(),
  /** Opt-in: the buddy sits on the pass email's card, as in the sign-in email. */
  'email.buddy': z.boolean().default(false),
});
