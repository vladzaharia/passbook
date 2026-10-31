import type { z } from 'zod';
import type { MappingSchema } from '@/shared/contracts/connections.ts';

export type Mapping = z.infer<typeof MappingSchema>;
export type TransformKind = NonNullable<Mapping[string]['transform']>['kind'];

export const TRANSFORMS: { value: TransformKind | 'none'; label: string; options: boolean }[] = [
  { value: 'none', label: 'None', options: false },
  { value: 'trim', label: 'Trim', options: false },
  { value: 'upper', label: 'Uppercase', options: false },
  { value: 'lower', label: 'Lowercase', options: false },
  { value: 'date', label: 'Date', options: false },
  { value: 'enum', label: 'Enum map', options: true },
  { value: 'bool-status', label: 'Boolean to status', options: true },
  { value: 'constant', label: 'Constant', options: true },
];

export interface MappingRow {
  id: string;
  input: string;
  from: string;
  kind: TransformKind | 'none';
  /** JSON text so partial edits survive while typing. */
  options: string;
}

let counter = 0;
export function blankRow(): MappingRow {
  counter += 1;
  return { id: `row-${counter}`, input: '', from: '', kind: 'none', options: '' };
}

export function toRows(mapping: Mapping | null | undefined): MappingRow[] {
  return Object.entries(mapping ?? {}).map(([input, entry]) => ({
    ...blankRow(),
    input,
    from: entry.from,
    kind: entry.transform?.kind ?? 'none',
    options: entry.transform?.options ? JSON.stringify(entry.transform.options, null, 2) : '',
  }));
}

export interface MappingResult {
  mapping: Mapping;
  /** Row id to message. */
  errors: Record<string, string>;
}

/** Rows to the API shape; blank rows are skipped, bad rows reported. */
export function fromRows(rows: MappingRow[]): MappingResult {
  const mapping: Mapping = {};
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const input = row.input.trim();
    const from = row.from.trim();
    if (!input && !from) continue;
    if (!input) errors[row.id] = 'Choose a template input.';
    else if (!from) errors[row.id] = 'Enter an upstream pointer.';
    else if (seen.has(input)) errors[row.id] = `${input} is mapped twice.`;
    if (errors[row.id]) continue;
    seen.add(input);
    const entry: Mapping[string] = { from };
    if (row.kind !== 'none') {
      const wantsOptions = TRANSFORMS.find((t) => t.value === row.kind)?.options;
      let options: Record<string, never> | undefined;
      if (wantsOptions && row.options.trim()) {
        try {
          const parsed: unknown = JSON.parse(row.options);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('not an object');
          }
          options = parsed as Record<string, never>;
        } catch {
          errors[row.id] = 'Options must be a JSON object.';
          continue;
        }
      }
      entry.transform = { kind: row.kind, ...(options ? { options } : {}) };
    }
    mapping[input] = entry;
  }
  return { mapping, errors };
}
