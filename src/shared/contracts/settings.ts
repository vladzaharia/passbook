import { z } from 'zod';
import { strictEmail } from '../email.ts';
import { DATA_CLASSES, type RetentionClass } from '../privacy/data-classes.ts';
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
  'email.senderName': PlainLineSchema(80).default('PassBook'),
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
  /** Opt-in: the buddy sits on the pass email's card, as in the sign-in email. */
  'email.buddy': z.boolean().default(false),
  /** Third-party NFC tags. Off until an admin turns it on. */
  'nfc.tags': z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});
