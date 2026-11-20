import { EXAMPLE_IDS } from './ids.ts';
import { resolve } from './schema.ts';
import type { Dict, Json, RawDoc } from './types.ts';

const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});

/** A 16 px PNG, for the fields that take an image as base64. */
const PNG_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg==';

/** A string that fits the schema's format or the field's name. */
function text(name: string, s: Dict): string {
  if (Array.isArray(s.enum)) return String(s.enum.includes('test') ? 'test' : s.enum[0]);
  if (/^png$/.test(name)) return PNG_PIXEL;
  if (/timeZone$/i.test(name)) return 'Europe/Berlin';
  if (s.format === 'email' || /email/i.test(name)) return 'ada@example.com';
  if (s.format === 'uri' || s.format === 'url' || /url$/i.test(name)) return 'https://example.com';
  if (/^orgId$/.test(name)) return EXAMPLE_IDS.orgId;
  if (/^templateIds?$/.test(name)) return EXAMPLE_IDS.templateId;
  if (/^passIds?$/.test(name)) return EXAMPLE_IDS.passId;
  if (s.format === 'uuid' || /ids?$/i.test(name)) return EXAMPLE_IDS.otherId;
  const min = typeof s.minLength === 'number' ? s.minLength : 1;
  return 'Example'.padEnd(min, 'x');
}

/**
 * The smallest value that satisfies a schema: required properties only, the first enum value, the
 * lower bound of a number. A fallback for operations whose contract gives no example, so no sample
 * ships an empty body where the API requires fields.
 */
export function minimalExample(doc: RawDoc, node: unknown, name = '', depth = 0): Json {
  const s = resolve(doc, node);
  if (s.example !== undefined) return s.example as Json;
  if (s.const !== undefined) return s.const as Json;
  const alt = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (alt?.length)
    return minimalExample(doc, alt.find((a) => asDict(a).type !== 'null') ?? alt[0], name, depth);
  const parts = s.allOf as unknown[] | undefined;
  if (parts) {
    const merged = parts.map((p) => minimalExample(doc, p, name, depth));
    return Object.assign({}, ...merged.filter((m) => m && typeof m === 'object')) as Json;
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'string') return text(name, s);
  if (type === 'integer' || type === 'number') return typeof s.minimum === 'number' ? s.minimum : 1;
  if (type === 'boolean') return false;
  if (type === 'array') {
    const min = typeof s.minItems === 'number' ? s.minItems : 0;
    return min > 0 && depth < 4 ? [minimalExample(doc, s.items, name, depth + 1)] : [];
  }
  if (type === 'object' || s.properties) {
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const props = asDict(s.properties);
    const out: Record<string, Json> = {};
    if (depth < 5)
      for (const key of required)
        if (key in props) out[key] = minimalExample(doc, props[key], key, depth + 1);
    return out;
  }
  return null;
}
