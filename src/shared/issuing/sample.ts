// The template's sample import file: the field labels and Holder email as headers, one valid row.
import { BOM, toCsv } from '../csv/write.ts';
import { type InputField, inputFields } from './fields.ts';

const MAPPABLE = new Set(['string', 'number', 'integer', 'boolean']);
const HOLDER_EMAIL = 'Holder email';

/** Shapes a `pattern` is tried against, most plain first: the first that fits is the example. */
const SHAPES = [
  'A-1001',
  'ABC',
  'A1001',
  '1001',
  '+15550100123',
  'https://example.com/a',
  'A 1001',
];

function fitting(def: Record<string, unknown>, candidates: readonly string[]): string | null {
  let re: RegExp | null = null;
  try {
    re = typeof def.pattern === 'string' ? new RegExp(def.pattern) : null;
  } catch {
    re = null;
  }
  const min = typeof def.minLength === 'number' ? def.minLength : 0;
  const max = typeof def.maxLength === 'number' ? def.maxLength : Number.MAX_SAFE_INTEGER;
  return (
    candidates.find((c) => c.length >= min && c.length <= max && (re === null || re.test(c))) ??
    null
  );
}

/** One value the field accepts; empty when an optional field's pattern is not one we can satisfy. */
function exampleOf(f: InputField, def: Record<string, unknown>, dateAt: number): string {
  if (f.options)
    return (f.options.find((o) => o.value === def.default) ?? f.options[0])?.label ?? '';
  if (def.default !== undefined && def.default !== null && typeof def.default !== 'object')
    return String(def.default);
  if (f.type === 'boolean') return 'Yes';
  // An optional number often depends on another field (a visit limit on one plan): leave it out.
  if ((f.type === 'integer' || f.type === 'number') && !f.required) return '';
  if (f.type === 'integer' || f.type === 'number') {
    const min = typeof def.minimum === 'number' ? def.minimum : 0;
    return String(Math.max(min, 1));
  }
  // Later date fields fall later (a start, then an end), a month apart.
  if (f.format === 'date' || f.format === 'date-time')
    return `2030-${String(Math.min(dateAt + 1, 12)).padStart(2, '0')}-01`;
  const named: string[] = [];
  if (typeof def['x-example'] === 'string') named.push(def['x-example']);
  if (f.format === 'email') named.push('member@example.com');
  if (f.format === 'uri') named.push(`https://example.com/${f.key}`);
  if (/\bID$/.test(f.label)) named.push('A-1001');
  named.push(f.label.toLowerCase().includes('name') ? 'Alex Rivera' : `Sample ${f.label}`);
  const hit = fitting(def, [...named, ...SHAPES]);
  return hit ?? '';
}

/** CSV text with a BOM, ready to download. */
export function sampleCsv(schema: unknown): string {
  const props = (
    typeof schema === 'object' && schema !== null
      ? ((schema as { properties?: unknown }).properties ?? {})
      : {}
  ) as Record<string, Record<string, unknown>>;
  const fields = inputFields(schema).filter((f) => MAPPABLE.has(f.type));
  const header = [...fields.map((f) => f.label), HOLDER_EMAIL];
  let dates = 0;
  const row = [
    ...fields.map((f) =>
      exampleOf(
        f,
        props[f.key] ?? {},
        f.format === 'date' || f.format === 'date-time' ? dates++ : 0,
      ),
    ),
    'holder@example.com',
  ];
  return BOM + toCsv(header, [row]);
}
