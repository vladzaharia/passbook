import type { ZodType } from 'zod';
import { OrgSettingsSchema, PlatformSettingsSchema } from '@/shared/contracts/settings.ts';

export type FieldKind = 'boolean' | 'text' | 'int' | 'color';

export interface SettingField {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  /** Section heading; fields without one render as a flat list. */
  group?: string;
  /** Unit inside a number field ("s", "days"). */
  suffix?: string;
  /** Inclusive bounds for int fields; the error message names them. */
  range?: readonly [number, number];
  /** Spoken unit for the range error ('seconds', 'days'). */
  unit?: string;
  /** Optional org settings may be cleared; platform settings always hold a value. */
  optional?: boolean;
  schema: ZodType;
}

const P = PlatformSettingsSchema.shape;
const O = OrgSettingsSchema.shape;

export const PLATFORM_FIELDS: readonly SettingField[] = [
  {
    key: 'auth.magicLinkEnabled',
    group: 'Access and sign-in',
    label: 'Magic-link sign-in',
    kind: 'boolean',
    schema: P['auth.magicLinkEnabled'],
  },
  {
    key: 'email.senderName',
    group: 'Email',
    label: 'Email sender name',
    kind: 'text',
    help: 'Platform sender name for future messages.',
    schema: P['email.senderName'],
  },
  {
    key: 'oidc.trustEmail',
    group: 'Identity trust',
    label: 'Trust Polaris ID emails',
    kind: 'boolean',
    help: 'Off requires additional email proof when a new sign-in matches an existing email. A provider claim must still be verified.',
    schema: P['oidc.trustEmail'],
  },
  {
    key: 'refresh.userCooldownSeconds',
    group: 'Pass updates',
    label: 'Refresh cooldown',
    kind: 'int',
    suffix: 's',
    help: 'Per pass. 5 to 3600 seconds.',
    range: [5, 3600],
    unit: 'seconds',
    schema: P['refresh.userCooldownSeconds'],
  },
  {
    key: 'push.budgetPerDay',
    group: 'Pass updates',
    label: 'Notifications per pass per day',
    kind: 'int',
    help: 'Per rolling 24 hours. Updates past this arrive silently. 0 to 50.',
    range: [0, 50],
    schema: P['push.budgetPerDay'],
  },
  {
    key: 'retention.passVersionsKeep',
    group: 'Retention',
    label: 'Pass versions kept',
    kind: 'int',
    help: 'Historical versions in addition to the current version. 1 to 50.',
    range: [1, 50],
    schema: P['retention.passVersionsKeep'],
  },
  {
    key: 'retention.auditDays',
    group: 'Retention',
    label: 'Audit retention',
    kind: 'int',
    suffix: 'days',
    help: 'Audit records older than this may be deleted by the retention job. 30 to 3650 days.',
    range: [30, 3650],
    unit: 'days',
    schema: P['retention.auditDays'],
  },
  {
    key: 'retention.eventsDays',
    group: 'Retention',
    label: 'Sync log retention',
    kind: 'int',
    suffix: 'days',
    help: 'Pass events shown in the Sync log. Older records may be deleted. 7 to 3650 days.',
    range: [7, 3650],
    unit: 'days',
    schema: P['retention.eventsDays'],
  },
  {
    key: 'retention.scansDays',
    group: 'Retention',
    label: 'Scan retention',
    kind: 'int',
    suffix: 'days',
    help: 'Live scans older than this may be deleted. 30 to 3650 days.',
    range: [30, 3650],
    unit: 'days',
    schema: P['retention.scansDays'],
  },
  {
    key: 'sandbox.purgeDays',
    group: 'Retention',
    label: 'Test data retention',
    kind: 'int',
    suffix: 'days',
    help: 'Test passes, bundles, messages and emails older than this may be deleted. 1 to 365 days.',
    range: [1, 365],
    unit: 'days',
    schema: P['sandbox.purgeDays'],
  },
  {
    key: 'scan.undoWindowMinutes',
    group: 'Scanner safeguards',
    label: 'Scan undo window',
    kind: 'int',
    suffix: 'min',
    help: 'How long a scanner can undo its own scan. 1 to 60 minutes.',
    range: [1, 60],
    unit: 'minutes',
    schema: P['scan.undoWindowMinutes'],
  },
  {
    key: 'scan.lookupsPerHour',
    group: 'Scanner safeguards',
    label: 'People lookups per hour',
    kind: 'int',
    help: 'Name and email lookups per scanner per hour. 20 to 2000.',
    range: [20, 2000],
    schema: P['scan.lookupsPerHour'],
  },
];

export const ORG_FIELDS: readonly SettingField[] = [
  {
    key: 'branding.accent',
    label: 'Accent color',
    kind: 'color',
    optional: true,
    schema: O['branding.accent'],
  },
  {
    key: 'support.email',
    label: 'Support email',
    kind: 'text',
    optional: true,
    schema: O['support.email'],
  },
  {
    key: 'support.url',
    label: 'Support URL',
    kind: 'text',
    optional: true,
    schema: O['support.url'],
  },
  {
    key: 'email.buddy',
    label: 'Buddy in pass emails',
    kind: 'boolean',
    help: "The PassBook buddy sits beside the organization's name.",
    schema: O['email.buddy'],
  },
];

/** Draft strings hold what the inputs show; null clears an optional org setting. */
export type Draft = Record<string, string | boolean>;

export function toDraft(fields: readonly SettingField[], values: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const v = values[f.key];
    draft[f.key] = f.kind === 'boolean' ? v === true : v == null ? '' : String(v);
  }
  return draft;
}

export function parseField(
  f: SettingField,
  raw: string | boolean,
): { value?: unknown; error?: string } {
  if (f.kind === 'boolean') return { value: raw === true };
  const text = String(raw).trim();
  if (text === '') {
    return f.optional ? { value: null } : { error: 'Required.' };
  }
  const candidate = f.kind === 'int' ? Number(text) : text;
  if (f.kind === 'int' && !Number.isInteger(candidate)) return { error: 'Enter a whole number.' };
  const res = f.schema.safeParse(candidate);
  if (!res.success) {
    if (f.kind === 'color') return { error: 'Use a 6-digit hex like #0f766e.' };
    if (f.range) {
      const [min, max] = f.range;
      return { error: `Use ${min} to ${max}${f.unit ? ` ${f.unit}` : ''}.` };
    }
    return { error: res.error.issues[0]?.message ?? 'Invalid value.' };
  }
  return { value: candidate };
}

export function changedValues(
  fields: readonly SettingField[],
  draft: Draft,
  initial: Draft,
): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (draft[f.key] === initial[f.key]) continue;
    const res = parseField(f, draft[f.key] ?? '');
    if (res.error) errors[f.key] = res.error;
    else values[f.key] = res.value;
  }
  return { values, errors };
}
