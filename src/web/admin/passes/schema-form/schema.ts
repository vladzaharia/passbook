import { EMAIL_INVALID_MESSAGE, strictEmail } from '@/shared/email.ts';

export type Widget =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'date'
  | 'datetime'
  | 'url'
  | 'email'
  | 'image'
  | 'password'
  | 'timezone'
  | 'list';

export type FormValues = Record<string, unknown>;

export interface FieldDef {
  key: string;
  label: string;
  help?: string | undefined;
  placeholder?: string | undefined;
  group: string;
  order: number;
  widget: Widget;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  /** Server-applied default, if the schema declares one. */
  hasDefault: boolean;
  /** Label of the checkbox that omits an optional date-time (`x-noneLabel`). */
  noneLabel: string;
  options?: { value: string; label: string }[] | undefined;
  schema: Record<string, unknown>;
  /** `list` widget: the fields of each row, from the schema's `items`. */
  rows?: ListDef | undefined;
}

export interface ListDef {
  fields: FieldDef[];
  /** Names a row: "Event 2". */
  itemLabel: string;
  addLabel: string;
  min: number;
  max: number;
}

export interface FieldGroup {
  name: string;
  fields: FieldDef[];
}

const WIDGETS = new Set<string>([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'date',
  'datetime',
  'url',
  'email',
  'image',
  'password',
  'timezone',
  'list',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function itemsOf(def: Record<string, unknown>): Record<string, unknown> | undefined {
  const items = def.items;
  return isObject(items) && isObject(items.properties) ? items : undefined;
}

function typeOf(def: Record<string, unknown>): FieldDef['type'] {
  if (def.type === 'array' && itemsOf(def)) return 'array';
  const t = Array.isArray(def.type) ? def.type.find((x) => x !== 'null') : def.type;
  return t === 'number' || t === 'integer' || t === 'boolean' ? t : 'string';
}

function widgetOf(def: Record<string, unknown>, type: FieldDef['type']): Widget {
  if (type === 'array') return 'list';
  if (def['x-timeZone'] === true) return 'timezone';
  const hint = str(def['x-widget']);
  if (hint && WIDGETS.has(hint)) return hint as Widget;
  if (Array.isArray(def.enum) && def.enum.length > 0) return 'select';
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  const format = str(def.format);
  if (format === 'date') return 'date';
  if (format === 'date-time') return 'datetime';
  if (format === 'email') return 'email';
  if (format === 'uri' || format === 'url') return 'url';
  if (str(def.contentMediaType)?.startsWith('image/')) return 'image';
  if (typeof def.maxLength === 'number' && def.maxLength > 200) return 'textarea';
  return 'text';
}

function optionsOf(def: Record<string, unknown>): FieldDef['options'] {
  if (!Array.isArray(def.enum)) return undefined;
  const labels = isObject(def['x-enumLabels']) ? def['x-enumLabels'] : {};
  return def.enum.map((v) => {
    const value = String(v);
    return { value, label: str(labels[value]) ?? value };
  });
}

function listOf(def: Record<string, unknown>, type: FieldDef['type']): ListDef | undefined {
  const items = itemsOf(def);
  if (type !== 'array' || !items) return undefined;
  const itemLabel = str(def['x-itemLabel']) ?? 'Item';
  return {
    fields: flatFields(describeSchema(items)),
    itemLabel,
    addLabel: str(def['x-addLabel']) ?? `Add ${itemLabel.toLowerCase()}`,
    min: typeof def.minItems === 'number' ? def.minItems : 0,
    max: typeof def.maxItems === 'number' ? def.maxItems : 50,
  };
}

/** Turns a template input schema into ordered, grouped field definitions. */
export function describeSchema(schema: unknown): FieldGroup[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields: FieldDef[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    const def = isObject(raw) ? raw : {};
    const type = typeOf(def);
    fields.push({
      key,
      label: str(def['x-label']) ?? str(def.title) ?? humanize(key),
      help: str(def['x-help']) ?? str(def.description),
      placeholder: str(def['x-placeholder']),
      group: str(def['x-group']) ?? '',
      order: typeof def['x-order'] === 'number' ? def['x-order'] : Number.MAX_SAFE_INTEGER,
      widget: widgetOf(def, type),
      type,
      required: required.has(key),
      noneLabel: str(def['x-noneLabel']) ?? 'No date',
      hasDefault: 'default' in def && def.default !== undefined,
      options: optionsOf(def),
      schema: def,
      rows: listOf(def, type),
    });
  }
  const position = new Map(fields.map((f, i) => [f.key, i]));
  fields.sort(
    (a, b) => a.order - b.order || (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0),
  );
  const groups: FieldGroup[] = [];
  for (const field of fields) {
    let group = groups.find((g) => g.name === field.group);
    if (!group) {
      group = { name: field.group, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

export function flatFields(groups: FieldGroup[]): FieldDef[] {
  return groups.flatMap((g) => g.fields);
}

function validateField(field: FieldDef, value: unknown): string | undefined {
  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (field.type === 'array' && Array.isArray(value) && value.length === 0);
  if (empty) return field.required ? 'Required.' : undefined;
  const s = field.schema;
  if (field.type === 'array') return Array.isArray(value) ? undefined : 'Must be a list.';
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? undefined : 'Must be true or false.';
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) return 'Must be a number.';
    if (field.type === 'integer' && !Number.isInteger(value)) return 'Must be a whole number.';
    if (typeof s.minimum === 'number' && value < s.minimum) return `At least ${s.minimum}.`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `At most ${s.maximum}.`;
    return undefined;
  }
  if (typeof value !== 'string') return 'Must be text.';
  if (field.options && !field.options.some((o) => o.value === value)) {
    return 'Choose one of the listed values.';
  }
  if (typeof s.minLength === 'number' && value.length < s.minLength) {
    return `At least ${s.minLength} characters.`;
  }
  if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
    return `At most ${s.maxLength} characters.`;
  }
  if (field.widget === 'email' && !strictEmail(value)) return EMAIL_INVALID_MESSAGE;
  if (field.widget === 'url') {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Enter an http(s) URL.';
    } catch {
      return 'Enter a valid URL.';
    }
  }
  if (field.widget === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Use YYYY-MM-DD.';
  if (field.widget === 'datetime' && Number.isNaN(Date.parse(value))) {
    return 'Enter a valid date and time.';
  }
  if (typeof s.pattern === 'string') {
    try {
      if (!new RegExp(s.pattern).test(value)) return 'Does not match the expected format.';
    } catch {
      // An unusable pattern is the server's to enforce.
    }
  }
  return undefined;
}

function validateList(field: FieldDef, value: unknown, errors: Record<string, string>): void {
  const rows = field.rows;
  if (!rows || !Array.isArray(value)) return;
  if (value.length < rows.min && value.length > 0) errors[field.key] = `Add at least ${rows.min}.`;
  if (value.length > rows.max) errors[field.key] = `At most ${rows.max}.`;
  value.forEach((row, i) => {
    const record = isObject(row) ? row : {};
    for (const sub of rows.fields) {
      const message = validateField(sub, record[sub.key]);
      if (message) errors[rowErrorKey(field.key, i, sub.key)] = message;
    }
  });
}

/** Where a list row's error lives: `events.2.name`. */
export function rowErrorKey(list: string, index: number, field: string): string {
  return `${list}.${index}.${field}`;
}

/** Field key to message; list rows use `list.index.field`. Empty when valid. */
export function validateValues(schema: unknown, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of flatFields(describeSchema(schema))) {
    const message = validateField(field, values[field.key]);
    if (message) errors[field.key] = message;
    else if (field.type === 'array') validateList(field, values[field.key], errors);
  }
  return errors;
}

const sortKeys = (v: FormValues): FormValues =>
  Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)));

/** Drops empty values so optional fields are omitted from the request. */
export function cleanValues(values: FormValues): FormValues {
  const out: FormValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    if (Array.isArray(value)) {
      const rows = value
        .map((row) => (isObject(row) ? sortKeys(cleanValues(row)) : row))
        .filter((row) => !isObject(row) || Object.keys(row).length > 0);
      if (rows.length > 0) out[key] = rows;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Only keys the schema declares; connection-sourced extras stay out of the draft. */
export function pickDeclared(schema: unknown, values: FormValues): FormValues {
  const keys = new Set(flatFields(describeSchema(schema)).map((f) => f.key));
  return Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k)));
}

function sortedEntries(v: FormValues): [string, unknown][] {
  return Object.entries(cleanValues(v)).sort(([x], [y]) => (x < y ? -1 : 1));
}

export function sameValues(a: FormValues, b: FormValues): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

/** Schema defaults the server would apply, to seed a new-pass form. */
export function defaultValues(schema: unknown): FormValues {
  const out: FormValues = {};
  for (const field of flatFields(describeSchema(schema))) {
    if (field.hasDefault) out[field.key] = field.schema.default;
  }
  return out;
}

/** Input keys that feed `pointer` through a plain `{{key}}` binding. */
export function keysBoundTo(manifest: unknown, pointer: string): Set<string> {
  const out = new Set<string>();
  const bindings = isObject(manifest) && Array.isArray(manifest.bindings) ? manifest.bindings : [];
  for (const b of bindings) {
    if (!isObject(b) || !isObject(b.to) || b.to.pointer !== pointer) continue;
    const m = typeof b.value === 'string' ? /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(b.value) : null;
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}
