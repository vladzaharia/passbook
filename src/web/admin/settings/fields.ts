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
    schema: P['refresh.userCooldownSeconds'],
  },
  {
    key: 'retention.passVersionsKeep',
    group: 'Passes and retention',
    label: 'Pass versions kept',
    kind: 'int',
    help: '1 to 50.',
    schema: P['retention.passVersionsKeep'],
  },
  {
    key: 'retention.auditDays',
    group: 'Passes and retention',
    label: 'Audit retention',
    kind: 'int',
    suffix: 'days',
    help: '30 to 3650.',
    schema: P['retention.auditDays'],
  },
];

export const ORG_FIELDS: readonly SettingField[] = [
  {
    key: 'branding.accent',
    label: 'Accent colour',
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
