import type { FormValues } from '../passes/schema-form/index.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A connector config schema with nested objects (`auth`, `list`) as dotted keys (`auth.type`),
 * so the flat form renders them; each child joins a group named by its parent's `x-label`.
 * Children of optional parents are optional.
 */
export function flattenSchema(schema: unknown): Obj | undefined {
  if (!isObj(schema) || !isObj(schema.properties)) return undefined;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const properties: Obj = {};
  const flatRequired: string[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    const def = isObj(raw) ? raw : {};
    if (isObj(def.properties)) {
      const inner = new Set(Array.isArray(def.required) ? (def.required as string[]) : []);
      const group = typeof def['x-label'] === 'string' ? def['x-label'] : key;
      for (const [child, rawChild] of Object.entries(def.properties)) {
        const childDef = isObj(rawChild) ? rawChild : {};
        properties[`${key}.${child}`] = { 'x-group': group, ...childDef };
        if (required.has(key) && inner.has(child) && !('default' in childDef))
          flatRequired.push(`${key}.${child}`);
      }
      continue;
    }
    properties[key] = def;
    if (required.has(key)) flatRequired.push(key);
  }
  return { ...schema, properties, required: flatRequired };
}

/** `{ auth: { type: 'bearer' } }` to `{ 'auth.type': 'bearer' }`. */
export function flattenValues(values: Obj): FormValues {
  const out: FormValues = {};
  for (const [key, v] of Object.entries(values)) {
    if (isObj(v)) for (const [child, cv] of Object.entries(v)) out[`${key}.${child}`] = cv;
    else out[key] = v;
  }
  return out;
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** The inverse; a parent whose children are all blank is left out (optional `list`). */
export function nestValues(flat: FormValues): Obj {
  const out: Obj = {};
  for (const [key, v] of Object.entries(flat)) {
    const dot = key.indexOf('.');
    if (dot < 0) {
      if (!blank(v)) out[key] = v;
      continue;
    }
    if (blank(v)) continue;
    const parent = key.slice(0, dot);
    const child = key.slice(dot + 1);
    const into = isObj(out[parent]) ? (out[parent] as Obj) : {};
    into[child] = v;
    out[parent] = into;
  }
  return out;
}

/** Secret fields tagged `x-auth` show only for their auth type; untagged ones always show. */
export function secretKeysFor(schema: unknown, authType: string): Set<string> {
  const hidden = new Set<string>();
  if (!isObj(schema) || !isObj(schema.properties)) return hidden;
  for (const [key, raw] of Object.entries(schema.properties)) {
    const tags = isObj(raw) && Array.isArray(raw['x-auth']) ? (raw['x-auth'] as string[]) : null;
    if (tags && !tags.includes(authType)) hidden.add(key);
  }
  return hidden;
}

/** The auth choice a connector offers (`auth.type` enum with labels), if any. */
export function authOptions(flat: Obj | undefined): { value: string; label: string }[] | null {
  const props = flat && isObj(flat.properties) ? flat.properties : {};
  const def = props['auth.type'];
  if (!isObj(def) || !Array.isArray(def.enum)) return null;
  const labels = isObj(def['x-enumLabels']) ? def['x-enumLabels'] : {};
  return def.enum.map((v) => ({
    value: String(v),
    label: typeof labels[String(v)] === 'string' ? (labels[String(v)] as string) : String(v),
  }));
}

/** Config keys the wizard leaves to defaults (edited later on the Configuration tab). */
export const WIZARD_HIDDEN = (flat: Obj | undefined, authType: string): Set<string> => {
  const hidden = new Set<string>();
  const props = flat && isObj(flat.properties) ? flat.properties : {};
  for (const [key, raw] of Object.entries(props)) {
    // Webhook headers and list pointers keep their defaults; the Configuration tab edits them.
    if (key.startsWith('webhook.') || key === 'auth.type') hidden.add(key);
    if (key.startsWith('list.') && key !== 'list.path') hidden.add(key);
    const tags = isObj(raw) && Array.isArray(raw['x-auth']) ? (raw['x-auth'] as string[]) : null;
    if (tags && !tags.includes(authType)) hidden.add(key);
  }
  return hidden;
};

/** Server field errors under a prefix ("config."), keyed without it. */
export function prefixed(fields: Record<string, string>, prefix: string) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields))
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
