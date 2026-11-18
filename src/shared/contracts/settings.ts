import { z } from 'zod';
import { strictEmail } from '../email.ts';
import { checkFromName } from '../email-from-name.ts';
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

/** Defaults for the email caps: per recipient per hour, per org per day. */
export const EMAIL_RECIPIENT_HOURLY_CAP = 3;
export const EMAIL_ORG_DAILY_CAP = 500;

/** Notifying updates one pass may get per rolling 24 hours, until the setting is changed. */
export const PUSH_BUDGET_DEFAULT = 3;

export const PlatformSettingsSchema = z.object({
  'oidc.trustEmail': z.boolean().default(false),
  'auth.magicLinkEnabled': z.boolean().default(true),
  'email.senderName': PlainLineSchema(80).default('PassBook'),
  /** The most any org may set its daily pass-email cap to; an org's own value is clamped to it. */
  'email.orgCapPerDayMax': z.number().int().min(10).max(5000).default(EMAIL_ORG_DAILY_CAP),
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
  /** Join links: public self-issue. Off stops every link. */
  'join.enabled': z.boolean().default(true),
  /** Join cards one org may issue per rolling 24 hours across its live links. */
  'join.orgDailyCap': z.number().int().min(1).max(50000).default(1000),
  /** Join cards the platform issues per UTC day; over it every link answers closed. */
  'join.platformDailyCap': z.number().int().min(1).max(1000000).default(20000),
  /** Live join cards nobody used are deleted after this many days. */
  'join.unusedDays': z.number().int().min(7).max(365).default(30),
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
  /** The From display name of this org's pass emails. Unset: "<Org> via <platform sender name>". */
  'email.fromName': z
    .string()
    .max(200)
    .transform((value, ctx) => {
      const checked = checkFromName(value);
      if (checked.ok) return checked.value;
      ctx.addIssue({ code: 'custom', message: checked.error });
      return z.NEVER;
    })
    .optional(),
  /** Pass emails one recipient may get per hour from this org. */
  'email.recipientCapPerHour': z.number().int().min(1).max(20).default(EMAIL_RECIPIENT_HOURLY_CAP),
  /** Pass emails this org may send per day. */
  'email.orgCapPerDay': z.number().int().min(10).max(5000).default(EMAIL_ORG_DAILY_CAP),
  /** Opt-in: the buddy sits on the pass email's card, as in the sign-in email. */
  'email.buddy': z.boolean().default(false),
  /** Third-party NFC tags. Off until an admin turns it on. */
  'nfc.tags': z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});

export const ReplyToOrgSchema = z.object({ orgId: z.string().min(1) });
export const ReplyToConfirmSchema = z.object({
  orgId: z.string().min(1),
  token: z.string().min(16).max(200),
});
/** `pending` until the support address's owner follows the emailed link. */
export const ReplyToStatusSchema = z.object({
  address: z.string().nullable(),
  state: z.enum(['none', 'pending', 'confirmed']),
});
