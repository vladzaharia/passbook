import type { z } from 'zod';
import type { Json } from '@/shared/contracts/common.ts';
import type { MappingSchema } from '@/shared/contracts/connections.ts';
import { transform } from '@/shared/mapping/transform.ts';

export type Mapping = z.infer<typeof MappingSchema>;
export type TransformKind = NonNullable<Mapping[string]['transform']>['kind'];

export const TRANSFORMS: { value: TransformKind | 'none'; label: string; options: boolean }[] = [
  { value: 'none', label: 'None', options: false },
  { value: 'trim', label: 'Trim', options: false },
  { value: 'upper', label: 'Uppercase', options: false },
  { value: 'lower', label: 'Lowercase', options: false },
  { value: 'date', label: 'Date', options: true },
  { value: 'enum', label: 'Enum map', options: true },
  { value: 'bool-status', label: 'Boolean to status', options: true },
  { value: 'constant', label: 'Constant', options: true },
];

/** Example options shown for a transform. */
export const OPTIONS_HINT: Partial<Record<TransformKind, string>> = {
  date: '{"input": "dmy", "output": "date"}',
  enum: '{"map": {"gold": "Pro"}}',
  'bool-status': '{"true": "Member", "false": "Lapsed"}',
  constant: '{"value": "Member"}',
};

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
export function fromRows(
  rows: MappingRow[],
  /** Pinned rows may stay unmapped. */
  pinned: readonly TargetField[] = [],
): MappingResult {
  const mapping: Mapping = {};
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const input = row.input.trim();
    const from = row.from.trim();
    if (!input && !from) continue;
    if (!from && pinned.some((p) => p.key === input)) continue;
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

export interface SourceField {
  pointer: string;
  /** Shown instead of the pointer, e.g. a column header. */
  label?: string;
  /** Short preview from the last test sample. */
  preview?: string;
}

export interface TargetField {
  key: string;
  label: string;
  required: boolean;
  /** Enum values, when the template restricts them. */
  values?: readonly string[] | undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** "/member/name" -> "name": the field name of a pointer. */
export const leafOf = (pointer: string) =>
  (pointer.split('/').pop() ?? pointer).replace(/~1/g, '/').replace(/~0/g, '~');

/** The sample value after the row's transform, as the pass would get it. */
export function previewValue(row: MappingRow, sources: readonly SourceField[]): string | undefined {
  let options: Record<string, Json> = {};
  try {
    options = row.options.trim() ? (JSON.parse(row.options) as Record<string, Json>) : {};
  } catch {
    // Options are mid-edit; preview without them.
    options = {};
  }
  const raw = sources.find((s) => s.pointer === row.from.trim())?.preview;
  if (row.kind !== 'constant' && raw === undefined) return undefined;
  try {
    const out = transform(raw, {
      from: row.from,
      ...(row.kind === 'none' ? {} : { transform: { kind: row.kind, options } }),
    });
    if (out === undefined || out === null) return undefined;
    return typeof out === 'object' ? JSON.stringify(out) : String(out);
  } catch {
    // Options of the wrong shape, e.g. an enum without a map.
    return undefined;
  }
}

/** Rows for pinned targets that have none yet, first. */
export function withPinned(
  rows: readonly MappingRow[],
  pinned: readonly TargetField[],
): MappingRow[] {
  const have = new Set(rows.map((r) => r.input));
  const added = pinned
    .filter((p) => !have.has(p.key))
    .map((p) => ({ ...blankRow(), input: p.key }));
  return [...added, ...rows];
}

/**
 * Fills unmapped template fields from sources with the same name: the key or label equals the
 * pointer's field name, or the field name ends with the label ("memberName" for "Name"). Enum
 * fields map only when the sample value is one of their values.
 */
export function autoMap(
  rows: readonly MappingRow[],
  targets: readonly TargetField[],
  sources: readonly SourceField[],
): MappingRow[] {
  const mapped = new Set(rows.filter((r) => r.from.trim()).map((r) => r.input.trim()));
  const taken = new Set(rows.map((r) => r.from.trim()).filter(Boolean));
  const next = rows.filter((r) => r.input.trim() || r.from.trim());
  for (const t of targets) {
    if (mapped.has(t.key)) continue;
    const key = norm(t.key);
    const label = norm(t.label);
    const fits = (s: SourceField) =>
      !taken.has(s.pointer) &&
      (!t.values || s.preview === undefined || t.values.includes(s.preview));
    const names = (s: SourceField) => [
      norm(leafOf(s.pointer)),
      ...(s.label ? [norm(s.label)] : []),
    ];
    const exact = sources.find((s) => fits(s) && names(s).some((n) => [key, label].includes(n)));
    const suffix =
      exact ??
      sources.find((s) => fits(s) && label.length > 2 && names(s).some((n) => n.endsWith(label)));
    if (!suffix) continue;
    taken.add(suffix.pointer);
    const blank = next.findIndex((r) => r.input.trim() === t.key && !r.from.trim());
    if (blank >= 0) next[blank] = { ...(next[blank] as MappingRow), from: suffix.pointer };
    else next.push({ ...blankRow(), input: t.key, from: suffix.pointer });
  }
  return next;
}
