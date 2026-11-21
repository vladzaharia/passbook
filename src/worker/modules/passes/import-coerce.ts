import type { Json } from '../../../shared/contracts/common.ts';
import { transform } from '../../../shared/mapping/transform.ts';

const BOOLEANS: Record<string, boolean> = {
  true: true,
  yes: true,
  y: true,
  '1': true,
  false: false,
  no: false,
  n: false,
  '0': false,
};

function typeOf(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const t = (schema as { type?: unknown }).type;
  if (typeof t === 'string') return t;
  return Array.isArray(t) ? (t.find((x) => x !== 'null' && typeof x === 'string') ?? null) : null;
}

/** A comma decimal is read only when the cell has no other comma or dot (`1,5`, not `1,234.5`). */
function numberOf(text: string): number | null {
  const plain = /^[+-]?\d*,\d+$/.test(text) ? text.replace(',', '.') : text;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/** An enum option by key or label, ignoring case; the text itself when it names none. */
function optionOf(schema: Record<string, unknown>, text: string): string {
  if (!Array.isArray(schema.enum)) return text;
  const labels = (schema['x-enumLabels'] ?? {}) as Record<string, unknown>;
  const fold = text.toLowerCase();
  const hit = schema.enum.find(
    (k) =>
      typeof k === 'string' &&
      (k.toLowerCase() === fold || String(labels[k] ?? '').toLowerCase() === fold),
  );
  return typeof hit === 'string' ? hit : text;
}

/** A date written `YYYY-MM-DD` (or with a time) in a date-time input becomes ISO text; other text stays for the check to refuse. */
function dateOf(format: unknown, text: string): string {
  if (
    (format !== 'date' && format !== 'date-time') ||
    !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)
  )
    return text;
  const read = transform(text, {
    from: '',
    transform: {
      kind: 'date',
      options: { input: 'ymd', output: format === 'date' ? 'date' : 'iso' },
    },
  });
  return typeof read === 'string' ? read : text;
}

function one(type: string | null, value: Json, schema: unknown = null): Json | undefined {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === '') return undefined;
  const def = (typeof schema === 'object' && schema !== null ? schema : {}) as Record<
    string,
    unknown
  >;
  if (type === 'string' || type === null) return optionOf(def, dateOf(def.format, text));
  if (type === 'integer' || type === 'number') {
    const n = numberOf(text);
    return n !== null && (type === 'number' || Number.isInteger(n)) ? n : text;
  }
  if (type === 'boolean') return BOOLEANS[text.toLowerCase()] ?? text;
  return text;
}

/**
 * Reads a row's mapped text as the template's input types. A cell that does not fit its type stays text,
 * so the template's own check words the failure. Blank cells are unset.
 */
export function coerceInput(
  inputs: { properties?: unknown },
  values: Record<string, Json>,
): Record<string, Json> {
  const props = (inputs.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(values)) {
    const schema = Object.hasOwn(props, key) ? props[key] : undefined;
    const type = typeOf(schema);
    let next: Json | undefined;
    if (type === 'array' && typeof value === 'string') {
      const items = (schema as { items?: unknown }).items;
      next = value
        .split(';')
        .map((v) => one(typeOf(items), v, items))
        .filter((v): v is Json => v !== undefined);
      if (next.length === 0) next = undefined;
    } else {
      next = one(type, value, schema);
    }
    if (next !== undefined) out[key] = next;
  }
  return out;
}
