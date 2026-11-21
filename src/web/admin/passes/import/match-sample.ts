import type { Json } from '@/shared/contracts/common.ts';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { inputFields } from '@/shared/issuing/fields.ts';
import { transform } from '@/shared/mapping/transform.ts';
import { formatCalendarDate } from '../../../lib/format.ts';
import { entryOf, type ImportPlan, type MatchRow, type MatchState } from './match-model.ts';

/** A file cell as the pass would show it: through the row's transform, dates in words. */
export function shownSample(row: MatchRow, cell: string, record: Record<string, string>): string {
  const entry = entryOf(row);
  if (!entry || row.kind === 'choice') {
    const hit = row.options.find((o) => o.value === cell);
    return hit?.label ?? cell;
  }
  const out = transform(cell, entry, record);
  if (typeof out !== 'string') return cell;
  return /^\d{4}-\d{2}-\d{2}/.test(out) ? formatCalendarDate(out.slice(0, 10)) : out;
}

/** The most sample rows any column has (at most three). */
export const sampleRowsOf = (columns: PassImportDto['columns']): number =>
  Math.max(1, ...columns.map((c) => c.samples.length));

/** What the sample row `i` would send as the template input, for the row card. */
export function previewInput(
  state: MatchState,
  columns: PassImportDto['columns'],
  i: number,
): Record<string, Json> {
  const record = Object.fromEntries(columns.map((c) => [c.label, c.samples[i] ?? '']));
  const out: Record<string, Json> = {};
  for (const row of state.rows) {
    const entry = row.role === 'input' ? entryOf(row) : null;
    const cell = columns.find((c) => c.pointer === row.from[0])?.label;
    if (!entry || cell === undefined || !record[cell]) continue;
    const v = transform(record[cell], entry, record);
    if (v === undefined || v === null || v === '') continue;
    out[row.target] = row.kind === 'number' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return out;
}

/** Words for how the plan finds existing passes. */
export function findLabel(
  plan: ImportPlan | null,
  columns: PassImportDto['columns'],
  schema: unknown,
): string {
  if (!plan || plan.match === 'none') return C.match.alwaysNewShort;
  if (plan.match === 'email') return C.match.byEmail;
  const id = plan.externalId?.from;
  const key = Object.entries(plan.mapping).find(([, e]) => e.from === id)?.[0];
  const label = inputFields(schema).find((f) => f.key === key)?.label;
  return label ?? columns.find((c) => c.pointer === id)?.label ?? C.match.externalId;
}
