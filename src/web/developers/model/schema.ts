import type { Dict, Field, RawDoc } from './types.ts';

const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});

/** Follows `$ref` chains into components. */
export function resolve(doc: RawDoc, node: unknown): Dict {
  let cur = asDict(node);
  for (let i = 0; i < 8 && typeof cur.$ref === 'string'; i++) {
    const name = cur.$ref.split('/').pop() ?? '';
    cur = asDict(doc.components.schemas[name] ?? doc.components.parameters?.[name]);
  }
  return cur;
}

/** The component name a node points at, for "Returns a Pass". */
export const refName = (node: unknown): string | null => {
  const ref = asDict(node).$ref;
  return typeof ref === 'string' ? (ref.split('/').pop() ?? null) : null;
};

/** `string · max 40`, `integer ≥ 0`, `"Silver" | "Gold"`, `uuid`: the one-line shape of a schema. */
export function typeLabel(doc: RawDoc, node: unknown): string {
  const s = resolve(doc, node);
  const alt = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (alt) return alt.map((a) => typeLabel(doc, a)).join(' | ');
  if (Array.isArray(s.enum)) return s.enum.map((e) => JSON.stringify(e)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : String(s.type ?? 'any');
  if (t === 'array') return `${typeLabel(doc, s.items)}[]`;
  const bits: string[] = [s.format ? String(s.format) : t];
  if (typeof s.maxLength === 'number') bits.push(`max ${s.maxLength}`);
  if (typeof s.minimum === 'number') bits.push(`≥ ${s.minimum}`);
  if (typeof s.maximum === 'number') bits.push(`≤ ${s.maximum}`);
  if (typeof s.pattern === 'string' && s.pattern.length <= 32) bits.push(s.pattern);
  return bits.join(' · ');
}

/** Object properties as rows, two levels deep; platform-only fields never publish. */
export function bodyFields(doc: RawDoc, node: unknown, depth = 0): Field[] {
  const s = resolve(doc, node);
  const props = asDict(s.properties);
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const rows: Field[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = resolve(doc, raw);
    if (p['x-platform-only']) continue;
    const nested = p.type === 'object' && p.properties && depth < 1;
    rows.push({
      name,
      where: 'body',
      type: typeLabel(doc, raw),
      required: required.has(name),
      deprecated: p.deprecated === true,
      description: typeof p.description === 'string' ? p.description : '',
      children: nested ? bodyFields(doc, p, depth + 1) : [],
    });
  }
  // Required first, as the design asks; the order within each stays the schema's.
  return rows.sort((a, b) => Number(b.required) - Number(a.required));
}

export function paramFields(doc: RawDoc, params: Dict[] | undefined): Field[] {
  const rows: Field[] = [];
  for (const raw of params ?? []) {
    const p = resolve(doc, raw);
    const where = p.in as Field['where'];
    if (p['x-platform-only'] || (where !== 'path' && where !== 'query' && where !== 'header'))
      continue;
    rows.push({
      name: String(p.name),
      where,
      type: typeLabel(doc, p.schema),
      required: p.required === true,
      deprecated: p.deprecated === true,
      description: typeof p.description === 'string' ? p.description : '',
      children: [],
    });
  }
  return rows;
}
