import type { z } from 'zod';
import type { Json } from '@/shared/contracts/common.ts';
import type {
  MappingDateFormat,
  MappingFieldSuggestion,
  MappingSuggestion,
  PlanMappingEntrySchema,
} from '@/shared/contracts/issuing.ts';
import type { PassImportDto, PassImportPlanSchema } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { type InputField, inputFields, isDateField } from '@/shared/issuing/fields.ts';
import { suggestMapping } from '@/shared/issuing/matcher.ts';
import { optionOf, readDates, valueCounts } from '@/shared/issuing/matcher-values.ts';

type Entry = z.infer<typeof PlanMappingEntrySchema>;
export type ImportPlan = z.input<typeof PassImportPlanSchema>;
export type Confidence = NonNullable<MappingFieldSuggestion['confidence']>;
export type RowKind = 'text' | 'choice' | 'date' | 'number' | 'email' | 'yesno';

export interface ValueRow {
  value: string;
  count: number;
  /** The option key, or null until the admin picks one. */
  to: string | null;
}

/** One template field (or the holder email) and the columns that feed it. */
export interface MatchRow {
  key: string;
  role: MappingFieldSuggestion['role'];
  target: string;
  label: string;
  required: boolean;
  hasDefault: boolean;
  kind: RowKind;
  options: { value: string; label: string }[];
  /** Column pointers; two or more join. */
  from: string[];
  confidence: Confidence | null;
  values: ValueRow[];
  date: {
    format: MappingDateFormat | null;
    choices: MappingDateFormat[];
    parsed: number;
    total: number;
  } | null;
  dateOutput: 'date' | 'iso';
  /** Counts come from the whole file; false once the column is changed here. */
  counted: boolean;
}

export interface MatchState {
  rows: MatchRow[];
  unused: { pointer: string; label: string }[];
  /** `col:<row key>`, `email` or `none`: how existing passes are found. */
  find: string;
}

export const DATE_FORMATS: { value: MappingDateFormat; label: string }[] = [
  { value: 'mdy', label: 'MM/DD/YYYY' },
  { value: 'dmy', label: 'DD/MM/YYYY' },
  { value: 'ymd', label: 'YYYY-MM-DD' },
  { value: 'iso', label: 'ISO 8601' },
];

const SAMPLE_ROWS = 3;
const FORMATS = new Set<string>(DATE_FORMATS.map((f) => f.value));
/** A choice value that issues no pass; only connections offer it (it becomes a void rule). */
export const SKIP = '__skip__';
export const rowKey = (role: string, target: string) => `${role}:${target}`;

function kindOf(f: InputField | undefined, role: MappingFieldSuggestion['role']): RowKind {
  if (role === 'holderEmail' || f?.format === 'email') return 'email';
  if (!f) return 'text';
  if (f.options) return 'choice';
  if (isDateField(f)) return 'date';
  if (f.type === 'number' || f.type === 'integer') return 'number';
  return f.type === 'boolean' ? 'yesno' : 'text';
}

function rowOf(s: MappingFieldSuggestion, f: InputField | undefined, counted: boolean): MatchRow {
  return {
    key: rowKey(s.role, s.target),
    role: s.role,
    target: s.target,
    label: s.label,
    required: s.required,
    hasDefault: f?.hasDefault ?? false,
    kind: kindOf(f, s.role),
    options: f?.options ?? [],
    from: s.from,
    confidence: s.confidence,
    values: s.values,
    date: s.date,
    dateOutput: f?.format === 'date' ? 'date' : 'iso',
    counted,
  };
}

const rest = (e: Entry) => (e.transform?.options?.with as string[] | undefined) ?? [];

/** The plan's choice for a row over the suggestion: its columns, value picks and date format. */
function overlay(row: MatchRow, e: Entry | null | undefined): MatchRow {
  if (!e) return { ...row, from: [], confidence: null };
  const from = [e.from, ...rest(e)];
  const same = from.join('\n') === row.from.join('\n');
  const map =
    e.transform?.kind === 'enum' ? (e.transform.options?.map as Record<string, string>) : undefined;
  const input = e.transform?.kind === 'date' ? String(e.transform.options?.input ?? '') : '';
  return {
    ...row,
    from,
    confidence: same ? row.confidence : null,
    values: same
      ? row.values.map((v) => {
          const hit = map
            ? Object.keys(map).find((k) => k.toLowerCase() === v.value.toLowerCase())
            : undefined;
          return hit === undefined ? v : { ...v, to: map?.[hit] ?? v.to };
        })
      : [],
    date:
      row.date && FORMATS.has(input)
        ? { ...row.date, format: input as MappingDateFormat }
        : same
          ? row.date
          : null,
  };
}

/** The server's suggestion when it sent one; else the same pure matcher over the sample cells. */
type Draft = Pick<PassImportDto, 'columns' | 'plan' | 'mapping'>;

function suggestionOf(imp: Draft, schema: unknown): MappingSuggestion {
  if (imp.mapping) return imp.mapping;
  const grid = Array.from({ length: SAMPLE_ROWS }, (_, i) =>
    imp.columns.map((c) => c.samples[i] ?? ''),
  );
  return suggestMapping(
    schema,
    imp.columns.map((c) => c.label),
    grid,
  );
}

/** Which row finds existing passes, from a plan's external ID column. */
function findOfPlan(plan: ImportPlan, rows: MatchRow[]): string {
  if (plan.match !== 'externalId') return plan.match;
  const id = plan.externalId?.from;
  const hit = rows.find((r) => r.role === 'input' && r.from.length === 1 && r.from[0] === id);
  return `col:${hit?.key ?? rowKey('externalId', 'externalId')}`;
}

/** The editable state of a draft: the suggestion, with the saved plan laid over it. */
export function stateOfImport(imp: Draft, schema: unknown): MatchState {
  const sugg = suggestionOf(imp, schema);
  const fields = new Map(inputFields(schema).map((f) => [f.key, f]));
  const plan = imp.plan;
  const rows = sugg.fields.map((s) => {
    const base = rowOf(
      s,
      s.role === 'input' ? fields.get(s.target) : undefined,
      Boolean(imp.mapping),
    );
    if (!plan) return base;
    if (s.role === 'externalId') return { ...base, from: [], confidence: null };
    return overlay(base, s.role === 'holderEmail' ? plan.holderEmail : plan.mapping[s.target]);
  });
  const match = sugg.fields.find((s) => s.matchBy);
  const find = plan
    ? findOfPlan(plan, rows)
    : match
      ? `col:${rowKey(match.role, match.target)}`
      : rows.find((r) => r.role === 'holderEmail')?.from.length
        ? 'email'
        : 'none';
  const used = new Set(rows.flatMap((r) => r.from));
  return {
    rows,
    unused: imp.columns
      .filter((c) => !used.has(c.pointer))
      .map(({ pointer, label }) => ({ pointer, label })),
    find,
  };
}

export function entryOf(row: MatchRow): Entry | null {
  const [from, ...others] = row.from;
  if (from === undefined) return null;
  if (others.length) return { from, transform: { kind: 'join', options: { with: others } } };
  if (row.kind === 'choice') {
    const map = Object.fromEntries(
      row.values.flatMap((v) => (v.to && v.to !== SKIP ? [[v.value, v.to]] : [])),
    );
    const labels = Object.fromEntries(row.options.map((o) => [o.value, o.label]));
    const options: Record<string, Json> = Object.keys(map).length ? { labels, map } : { labels };
    return { from, transform: { kind: 'enum', options } };
  }
  if (row.kind === 'date') {
    const input = row.date?.format ?? 'auto';
    return { from, transform: { kind: 'date', options: { input, output: row.dateOutput } } };
  }
  return { from };
}

export interface PlanResult {
  plan?: ImportPlan;
  /** Row key to message. */
  errors: Record<string, string>;
  matchError?: string;
}

/** The API plan for the rows and the find choice. */
export function planOfState(
  state: MatchState,
  settings: { keepManual: boolean; save: boolean; overrides?: ImportPlan['overrides'] },
): PlanResult {
  const errors: Record<string, string> = {};
  const mapping: Record<string, Entry> = {};
  let holderEmail: Entry | null = null;
  for (const row of state.rows) {
    if (row.role === 'externalId') continue;
    if (
      row.kind === 'date' &&
      row.from.length > 0 &&
      row.date?.format === null &&
      row.date.choices.length > 1
    )
      errors[row.key] = C.match.needDateFormat;
    const entry = entryOf(row);
    if (!entry) continue;
    if (row.role === 'holderEmail') holderEmail = entry;
    else mapping[row.target] = entry;
  }
  if (Object.keys(errors).length) return { errors };
  const base = {
    mapping,
    holderEmail,
    keepManual: settings.keepManual,
    save: settings.save,
    ...(settings.overrides ? { overrides: settings.overrides } : {}),
  };
  if (state.find === 'email') {
    if (!holderEmail) return { errors, matchError: C.match.needEmail };
    return { errors, plan: { ...base, externalId: null, match: 'email' } };
  }
  if (state.find.startsWith('col:')) {
    const row = state.rows.find((r) => r.key === state.find.slice(4));
    const from = row?.from[0];
    if (!from || row.from.length > 1) return { errors, matchError: C.match.needExternalId };
    return { errors, plan: { ...base, externalId: { from }, match: 'externalId' } };
  }
  return { errors, plan: { ...base, externalId: null, match: 'none', keepManual: false } };
}

/** Rows that read as pass fields: the template's own fields and the holder email; the ID rides on one of them. */
export const shownRows = (state: MatchState): MatchRow[] =>
  state.rows.filter((r) => r.role !== 'externalId');

/** Columns that can find existing passes: one plain column, text or number. */
export const findable = (state: MatchState): MatchRow[] =>
  state.rows.filter(
    (r) =>
      r.from.length === 1 && r.role !== 'holderEmail' && (r.kind === 'text' || r.kind === 'number'),
  );

/** A row fed by other columns: its value picks and date format are read again from their cells. */
export function setColumns(
  row: MatchRow,
  from: string[],
  columns: PassImportDto['columns'],
): MatchRow {
  const cells = columns.find((c) => c.pointer === from[0])?.samples ?? [];
  const next: MatchRow = { ...row, from, confidence: null, values: [], date: null, counted: false };
  if (from.length === 0) return next;
  if (row.kind === 'choice')
    next.values = valueCounts(cells).map((v) => ({ ...v, to: optionOf(v.value, row.options) }));
  if (row.kind === 'date')
    next.date = readDates(cells) ?? { format: null, choices: [], parsed: 0, total: cells.length };
  return next;
}
