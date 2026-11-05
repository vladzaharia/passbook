import { formatDateTime } from '../../lib/format.ts';
import { describeSchema, type FieldDef, flatFields } from '../passes/schema-form/index.ts';

export interface PatchRow {
  key: string;
  label: string;
  value: string;
}

function show(field: FieldDef | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Cleared';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field?.options) return field.options.find((o) => o.value === value)?.label ?? String(value);
  if (typeof value === 'string' && (field?.widget === 'date' || field?.widget === 'datetime')) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : formatDateTime(ms);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** What a change sets, named and formatted the way the template's own form names it. */
export function patchRows(inputSchema: unknown, patch: Record<string, unknown>): PatchRow[] {
  const fields = new Map(flatFields(describeSchema(inputSchema)).map((f) => [f.key, f]));
  return Object.entries(patch).map(([key, value]) => ({
    key,
    label: fields.get(key)?.label ?? key,
    value: show(fields.get(key), value),
  }));
}
