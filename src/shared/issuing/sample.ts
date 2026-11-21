// The template's sample import file: the field labels and Holder email as headers, one valid row.
import { BOM, toCsv } from '../csv/write.ts';
import { type InputField, inputFields } from './fields.ts';

const MAPPABLE = new Set(['string', 'number', 'integer', 'boolean']);
const HOLDER_EMAIL = 'Holder email';

function exampleOf(f: InputField, def: Record<string, unknown>): string {
  if (f.options)
    return (f.options.find((o) => o.value === def.default) ?? f.options[0])?.label ?? '';
  if (def.default !== undefined && def.default !== null && typeof def.default !== 'object')
    return String(def.default);
  if (f.type === 'boolean') return 'Yes';
  if (f.type === 'integer' || f.type === 'number') {
    const min = typeof def.minimum === 'number' ? def.minimum : 0;
    return String(Math.max(min, 1));
  }
  if (f.format === 'date' || f.format === 'date-time') return '2030-01-31';
  if (f.format === 'email') return 'member@example.com';
  if (/\bID$/.test(f.label)) return 'A-1001';
  const text = f.label.toLowerCase().includes('name') ? 'Alex Rivera' : `Sample ${f.label}`;
  const max = typeof def.maxLength === 'number' ? def.maxLength : text.length;
  return text.slice(0, max);
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
  const row = [...fields.map((f) => exampleOf(f, props[f.key] ?? {})), 'holder@example.com'];
  return BOM + toCsv(header, [row]);
}
