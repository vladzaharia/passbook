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
    key: 'oidc.trustEmail',
    group: 'Sign-in',
    label: 'Trust Polaris ID emails',
    kind: 'boolean',
    help: 'Off requires a magic-link proof when a new sign-in matches an existing email.',
    schema: P['oidc.trustEmail'],
  },
  {
    key: 'auth.magicLinkEnabled',
    group: 'Sign-in',
    label: 'Magic-link sign-in',
    kind: 'boolean',
    help: 'Holders without Polaris ID cannot sign in.',
    schema: P['auth.magicLinkEnabled'],
  },
  {
    key: 'email.senderName',
    group: 'Email',
    label: 'Email sender name',
    kind: 'text',
    schema: P['email.senderName'],
  },
  {
    key: 'refresh.userCooldownSeconds',
    group: 'Passes and retention',
    label: 'Refresh cooldown',
    kind: 'int',
    suffix: 's',
    help: '5 to 3600 seconds, per user.',
    range: [5, 3600],
    unit: 'seconds',
    schema: P['refresh.userCooldownSeconds'],
  },
  {
    key: 'retention.passVersionsKeep',
    group: 'Passes and retention',
    label: 'Pass versions kept',
    kind: 'int',
    help: '1 to 50.',
    range: [1, 50],
    schema: P['retention.passVersionsKeep'],
  },
  {
    key: 'retention.auditDays',
    group: 'Passes and retention',
    label: 'Audit retention',
    kind: 'int',
    suffix: 'days',
    help: '30 to 3650.',
    range: [30, 3650],
    unit: 'days',
    schema: P['retention.auditDays'],
  },
  {
    key: 'retention.eventsDays',
    group: 'Passes and retention',
    label: 'Sync log retention',
    kind: 'int',
    suffix: 'days',
    help: 'Pass events shown in the Sync log. 7 to 3650.',
    range: [7, 3650],
    unit: 'days',
    schema: P['retention.eventsDays'],
  },
  {
    key: 'sandbox.purgeDays',
    group: 'Passes and retention',
    label: 'Test data retention',
    kind: 'int',
    suffix: 'days',
    help: 'Test passes, bundles, messages and emails are deleted after this. 1 to 365.',
    range: [1, 365],
    unit: 'days',
    schema: P['sandbox.purgeDays'],
  },
  {
    key: 'push.budgetPerDay',
    group: 'Passes and retention',
    label: 'Notifications per pass per day',
    kind: 'int',
    help: '0 to 50. Updates past this arrive silently.',
    range: [0, 50],
    schema: P['push.budgetPerDay'],
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
