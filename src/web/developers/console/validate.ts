import { strictEmail } from '../../../shared/email.ts';
import type { Json, RunSchema } from './types.ts';

export interface Issue {
  /** `input.name`, or empty for the whole value. */
  path: string;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: Record<string, [(v: string) => boolean, string]> = {
  uuid: [(v) => UUID.test(v), 'must be a uuid'],
  email: [(v) => strictEmail(v) !== null, 'must be an email address'],
};

const kindOf = (v: Json): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function typeOk(types: string[], v: Json): boolean {
  const k = kindOf(v);
  return types.some((t) => t === k || (t === 'number' && k === 'integer'));
}

const join = (path: string, key: string | number) =>
  path ? (typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`) : String(key);

/**
 * The JSON Schema subset the document uses: types, enums, required, bounds, patterns, a few
 * formats, arrays, objects and one-of/any-of. Unknown keys pass: the server has the last word.
 */
export function validate(schema: RunSchema, value: Json, path = ''): Issue[] {
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null && (schema.nullable || types.includes('null'))) return [];
  const alts = schema.oneOf ?? schema.anyOf;
  if (alts && alts.length > 0) {
    return alts.some((a) => validate(a, value, path).length === 0)
      ? []
      : [{ path, message: 'does not match any allowed shape' }];
  }
  if (types.length > 0 && !typeOk(types, value))
    return [{ path, message: `must be ${types.join(' or ')}` }];
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    return [
      { path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` },
    ];
  const out: Issue[] = [];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      out.push({ path, message: `min ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      out.push({ path, message: `max ${schema.maxLength} characters` });
    const format = schema.format ? FORMATS[schema.format] : undefined;
    if (format && !format[0](value)) out.push({ path, message: format[1] });
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value))
          out.push({ path, message: 'has the wrong format' });
      } catch {
        // A pattern the browser cannot read is the server's to judge.
      }
    }
  } else if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      out.push({ path, message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      out.push({ path, message: `must be at most ${schema.maximum}` });
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      out.push({ path, message: `needs at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      out.push({ path, message: `allows at most ${schema.maxItems} items` });
    if (schema.items)
      for (const [i, v] of value.entries()) out.push(...validate(schema.items, v, join(path, i)));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? [])
      if (!(key in value)) out.push({ path: join(path, key), message: 'is required' });
    for (const [key, sub] of Object.entries(schema.properties ?? {}))
      if (key in value) out.push(...validate(sub, value[key] as Json, join(path, key)));
  }
  return out;
}
