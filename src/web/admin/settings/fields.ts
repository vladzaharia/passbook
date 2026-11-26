import type { ZodType } from 'zod';

export type FieldKind = 'boolean' | 'text' | 'int' | 'color' | 'zone';

export interface SettingField {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  /** Placeholder showing the format of an empty text field. */
  hint?: string;
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
  /** The stored value is `{ enabled }` rather than a bare boolean. */
  wrapped?: boolean;
  /** Key of the boolean that gates this field: hidden while it is off, the value kept. */
  parent?: string;
  schema: ZodType;
}

/** Draft strings hold what the inputs show; null clears an optional org setting. */
export type Draft = Record<string, string | boolean>;

export function toDraft(fields: readonly SettingField[], values: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const v = values[f.key];
    draft[f.key] =
      f.kind === 'boolean'
        ? v === true ||
          (typeof v === 'object' && v !== null && 'enabled' in v && v.enabled === true)
        : v == null
          ? ''
          : String(v);
  }
  return draft;
}

export function parseField(
  f: SettingField,
  raw: string | boolean,
): { value?: unknown; error?: string } {
  if (f.kind === 'boolean') return { value: f.wrapped ? { enabled: raw === true } : raw === true };
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
