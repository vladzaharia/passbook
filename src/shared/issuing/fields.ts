// The template inputs as the issuing flows read them: one flat field per top-level scalar input, in
// the form's order, with the label and options the admin sees.

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface InputField {
  key: string;
  label: string;
  type: FieldType;
  /** `date`, `date-time`, `email`, ... */
  format: string | undefined;
  required: boolean;
  hasDefault: boolean;
  /** Enum keys with their labels (`x-enumLabels`, else the key). */
  options: { value: string; label: string }[] | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** `memberId` -> `Member id`: the form's fallback label, so a key never shows raw. */
export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function typeOf(def: Record<string, unknown>): FieldType {
  const t = Array.isArray(def.type) ? def.type.find((x) => x !== 'null') : def.type;
  return t === 'number' || t === 'integer' || t === 'boolean' || t === 'array' || t === 'object'
    ? t
    : 'string';
}

function optionsOf(def: Record<string, unknown>): InputField['options'] {
  if (!Array.isArray(def.enum)) return undefined;
  const labels = isObject(def['x-enumLabels']) ? def['x-enumLabels'] : {};
  return def.enum
    .filter((v): v is string => typeof v === 'string')
    .map((value) => ({ value, label: str(labels[value]) ?? value }));
}

/** Every visible input, sorted like the pass form (`x-order`, then declaration order). */
export function inputFields(schema: unknown): InputField[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields: (InputField & { order: number; at: number })[] = [];
  let at = 0;
  for (const [key, raw] of Object.entries(schema.properties)) {
    const def = isObject(raw) ? raw : {};
    at += 1;
    if (def['x-hidden'] === true) continue;
    fields.push({
      key,
      label: str(def['x-label']) ?? str(def.title) ?? humanize(key),
      type: typeOf(def),
      format: str(def.format),
      required: required.has(key),
      hasDefault: 'default' in def && def.default !== undefined,
      options: optionsOf(def),
      order: typeof def['x-order'] === 'number' ? def['x-order'] : Number.MAX_SAFE_INTEGER,
      at,
    });
  }
  fields.sort((a, b) => a.order - b.order || a.at - b.at);
  return fields.map(({ order: _o, at: _a, ...f }) => f);
}

export const isDateField = (f: InputField): boolean =>
  f.type === 'string' && (f.format === 'date' || f.format === 'date-time');
