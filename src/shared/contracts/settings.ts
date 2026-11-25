import { z } from 'zod';
import { ORG_WEBSITE_INVALID } from '../copy/org-website.ts';
import { strictEmail } from '../email.ts';
import { checkFromName } from '../email-from-name.ts';
import { DATA_CLASSES, type RetentionClass } from '../privacy/data-classes.ts';
import { DEFAULT_TIME_ZONE } from '../time-zone.ts';
import { CHANNELS, ChannelSchema } from './channels.ts';
import { IdSchema, PlainLineSchema } from './common.ts';
import { TimeZoneSchema } from './scan-base.ts';

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
/** Whole days inside the class's floor and hard ceiling. */
const daysOf = (cls: RetentionClass) =>
  z.number().int().min(DATA_CLASSES[cls].floor).max(DATA_CLASSES[cls].ceiling);
/** Platform default of a class: the value an org without its own uses. */
const defaultDays = (cls: RetentionClass) => daysOf(cls).default(DATA_CLASSES[cls].platformDefault);
/** Platform maximum of a class: no org may choose more. */
const maxDays = (cls: RetentionClass) => daysOf(cls).default(DATA_CLASSES[cls].platformMax);

/** Notifying updates one pass may get per rolling 24 hours, until the setting is changed. */
export const PUSH_BUDGET_DEFAULT = 3;

export const PlatformSettingsSchema = z.object({
  'oidc.trustEmail': z.boolean().default(false),
  'auth.magicLinkEnabled': z.boolean().default(true),
  /** When email-link sign-in stops opening the console for members who had it (ms); null: it never does. */
  'auth.consoleEmailUntil': z.number().int().positive().nullable().default(null),
  'email.senderName': PlainLineSchema(80).default('PassBook'),
  /** The most any org may set its daily pass-email cap to; an org's own value is clamped to it. */
  'email.orgCapPerDayMax': z.number().int().min(10).max(5000).default(EMAIL_ORG_DAILY_CAP),
  'refresh.userCooldownSeconds': z.number().int().min(5).max(3600).default(30),
  'retention.passVersionsKeep': z.number().int().min(1).max(50).default(3),
  'retention.auditDays': z.number().int().min(365).max(3650).default(365),
  /** Sync log and device activity (pass_events). */
  'retention.eventsDays': defaultDays('events'),
  /** Test-mode passes, bundles and captured emails older than this are deleted daily. */
  'sandbox.purgeDays': z.number().int().min(1).max(365).default(30),
  /** Notifying updates one pass may get per rolling 24 hours; later updates are silent. */
  'push.budgetPerDay': z.number().int().min(0).max(50).default(PUSH_BUDGET_DEFAULT),
  /** Scans older than this are deleted daily. */
  'retention.scansDays': defaultDays('scans'),
  /** How long a scanner may undo its own scan. */
  'scan.undoWindowMinutes': z.number().int().min(1).max(60).default(10),
  /** Name and email lookups one scanner may run per hour. */
  'scan.lookupsPerHour': z.number().int().min(20).max(2000).default(200),
  /** Apple NFC (VAS). Off until Apple approves the pass type. */
  'nfc.enabled': z.boolean().default(false),
  /** Linked third-party NFC tags. On; independent of Apple NFC (VAS). Off stops every tag. */
  'nfc.tagsEnabled': z.boolean().default(true),
  /** Paper tickets. Off stops printing for every organization. */
  'print.enabled': z.boolean().default(true),
  /** Join links: public self-issue. Off stops every link. */
  'join.enabled': z.boolean().default(true),
  /** Join cards one org may issue per rolling 24 hours across its live links. */
  'join.orgDailyCap': z.number().int().min(1).max(50000).default(1000),
  /** Join cards the platform issues per UTC day; over it every link answers closed. */
  'join.platformDailyCap': z.number().int().min(1).max(1000000).default(20000),
  /** Live join cards nobody used are deleted after this many days. */
  'join.unusedDays': z.number().int().min(7).max(365).default(30),
  // Retention: `<class>Days` above is the default, `<class>MaxDays` the most an org may choose.
  'retention.visitorsDays': defaultDays('visitors'),
  'retention.deliveryDays': defaultDays('delivery'),
  'retention.photosDays': defaultDays('photos'),
  'retention.importsDays': defaultDays('imports'),
  'retention.webhooksDays': defaultDays('webhooks'),
  'retention.scansMaxDays': maxDays('scans'),
  'retention.eventsMaxDays': maxDays('events'),
  'retention.visitorsMaxDays': maxDays('visitors'),
  'retention.deliveryMaxDays': maxDays('delivery'),
  'retention.photosMaxDays': maxDays('photos'),
  'retention.importsMaxDays': maxDays('imports'),
  'retention.webhooksMaxDays': maxDays('webhooks'),
});
export const OrgSettingsSchema = z.object({
  /** The org's clock for day boundaries (zone Clear at, hours) where no zone or event has its own. Unset: Seattle. */
  'org.timeZone': TimeZoneSchema.default(DEFAULT_TIME_ZONE),
  /** The organization's own site; holder links to "visit the org" use it. Unset: the holder account page. */
  'org.website': z
    .string()
    .max(2048)
    .refine(isHttpsUrl, ORG_WEBSITE_INVALID)
    .transform((value) => new URL(value).href)
    .optional(),
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
  // Privacy (trust pack): retention per class, absent means the platform default; contacts for the about page.
  'retention.scansDays': daysOf('scans').optional(),
  'retention.eventsDays': daysOf('events').optional(),
  'retention.visitorsDays': daysOf('visitors').optional(),
  'retention.deliveryDays': daysOf('delivery').optional(),
  'retention.photosDays': daysOf('photos').optional(),
  'retention.importsDays': daysOf('imports').optional(),
  'retention.webhooksDays': daysOf('webhooks').optional(),
  'privacy.legalName': PlainLineSchema(120).optional(),
  'privacy.email': z
    .string()
    .max(254)
    .refine((v) => strictEmail(v) !== null, 'Enter a valid email address.')
    .optional(),
  'privacy.url': z
    .string()
    .max(500)
    .refine(isHttpsUrl, 'Use an https URL without credentials.')
    .optional(),
  /** Staff sign-in with a PIN alone on paired scanners. Turned off by the server after repeated wrong PINs; an admin turns it on. */
  'scan.pinOnly': z.boolean().default(true),
  /** Holder pages and emails use the pass logo as the web logo. Unset: on while there is no web logo. */
  'branding.webLogoSameAsLogo': z.boolean().optional(),
  /** Opt-in: the buddy sits on the pass email's card, as in the sign-in email. */
  'email.buddy': z.boolean().default(false),
  /** Third-party NFC tags. On until an admin turns it off. */
  'nfc.tags': z
    .object({
      enabled: z.boolean().default(true),
      /** The tag type a new tag gets when several fit; null or absent: Standard. */
      defaultType: IdSchema.nullable().optional(),
    })
    .default({ enabled: true }),
  /** Channels this org turns off for every template: copies keep working, nothing new is offered. */
  'channels.blocked': z.array(ChannelSchema).max(CHANNELS.length).default([]),
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
