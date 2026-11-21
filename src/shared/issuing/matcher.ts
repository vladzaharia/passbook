// Template-driven column matching for imports and connections: the template's fields pick their
// columns, not the other way round. Pure, so the Worker and the console suggest the same thing.
import type { z } from 'zod';
import type {
  MappingFieldSuggestion,
  MappingSuggestion,
  PlanMappingEntrySchema,
} from '../contracts/issuing.ts';
import { pointerOfKey } from '../mapping/pointer.ts';
import { type InputField, inputFields, isDateField } from './fields.ts';
import {
  isFirstName,
  isLastName,
  isNameTarget,
  type NameSignal,
  nameSignal,
} from './matcher-names.ts';
import {
  isEmail,
  optionOf,
  readDates,
  shareFitting,
  VALUES_FIT,
  VALUES_MIN,
  valueCounts,
} from './matcher-values.ts';

type Entry = z.infer<typeof PlanMappingEntrySchema>;
type Confidence = MappingFieldSuggestion['confidence'];

export interface SuggestOptions {
  /** The template's ID input (scan lookup, else barcode); see `idInputOf`. */
  idInput?: string | null | undefined;
}

interface Column {
  pointer: string;
  label: string;
  values: string[];
}

interface Target {
  role: MappingFieldSuggestion['role'];
  key: string;
  label: string;
  names: string[];
  required: boolean;
  field: InputField | null;
}

interface Pick {
  from: string[];
  confidence: Confidence;
}

const MAPPABLE = new Set(['string', 'number', 'integer', 'boolean']);
const SCORE: Record<Exclude<NameSignal, null>, number> = { exact: 2, similar: 1 };
const VALUE_MAX = 80;

/** The input the template looks a pass up by, else a required input labelled "... ID". */
export function idInputOf(schema: unknown, idInput?: string | null): string | null {
  const fields = inputFields(schema);
  if (idInput && fields.some((f) => f.key === idInput)) return idInput;
  return (
    fields.find((f) => f.required && f.type === 'string' && /\bID$/.test(f.label))?.key ?? null
  );
}

function targetsOf(schema: unknown): Target[] {
  const own: Target[] = [
    {
      role: 'holderEmail',
      key: 'holderEmail',
      label: 'Holder email',
      names: ['holderEmail', 'Holder email'],
      required: false,
      field: null,
    },
    {
      role: 'externalId',
      key: 'externalId',
      label: 'External ID',
      names: ['externalId', 'External ID'],
      required: false,
      field: null,
    },
  ];
  const inputs = inputFields(schema)
    .filter((f) => MAPPABLE.has(f.type))
    .map(
      (f): Target => ({
        role: 'input',
        key: f.key,
        label: f.label,
        names: [f.key, f.label],
        required: f.required,
        field: f,
      }),
    );
  return [...own, ...inputs];
}

/** The best-named column: exact beats similar, then file order. */
function byName(t: Target, columns: readonly Column[]): Pick | null {
  let best: { col: Column; score: number; signal: NameSignal } | null = null;
  for (const col of columns) {
    const signal = nameSignal(col.label, t.names);
    if (!signal) continue;
    if (!best || SCORE[signal] > best.score) best = { col, score: SCORE[signal], signal };
  }
  return best ? { from: [best.col.pointer], confidence: best.signal } : null;
}

/** A first and a last name column for a whole-name target. */
function byJoin(t: Target, columns: readonly Column[]): Pick | null {
  if (t.field?.type !== 'string' || !isNameTarget(t.names)) return null;
  const first = columns.find((c) => isFirstName(c.label));
  const last = columns.find((c) => isLastName(c.label));
  return first && last ? { from: [first.pointer, last.pointer], confidence: 'join' } : null;
}

/** The free column whose cells best fit the target's type, at 90% or more. */
function byValues(t: Target, columns: readonly Column[], taken: ReadonlySet<string>): Pick | null {
  const f = t.field;
  const ok: ((v: string) => boolean) | null =
    t.role === 'holderEmail'
      ? isEmail
      : f && isDateField(f)
        ? (v) => readDates([v]) !== null
        : f?.options
          ? (v) => optionOf(v, f.options ?? []) !== null
          : null;
  if (!ok) return null;
  let best: { col: Column; score: number } | null = null;
  for (const col of columns) {
    if (taken.has(col.pointer)) continue;
    const score = f && isDateField(f) ? dateFit(col.values) : shareFitting(col.values, ok);
    if (score >= VALUES_FIT && (!best || score > best.score)) best = { col, score };
  }
  return best ? { from: [best.col.pointer], confidence: 'values' } : null;
}

/** Dates fit only in one format: a column of mixed formats is not a date column. */
function dateFit(values: readonly string[]): number {
  const read = values.length >= VALUES_MIN ? readDates(values) : null;
  return read ? read.parsed / read.total : 0;
}

function suggestionOf(
  t: Target,
  pick: Pick | null,
  columns: readonly Column[],
): MappingFieldSuggestion {
  const base: MappingFieldSuggestion = {
    role: t.role,
    target: t.key,
    label: t.label,
    required: t.required,
    from: pick?.from ?? [],
    confidence: pick?.confidence ?? null,
    matchBy: false,
    entry: null,
    values: [],
    date: null,
  };
  const [from, ...rest] = base.from;
  if (from === undefined) return base;
  const cells = columns.find((c) => c.pointer === from)?.values ?? [];
  const f = t.field;
  if (rest.length) {
    return { ...base, entry: { from, transform: { kind: 'join', options: { with: rest } } } };
  }
  if (f?.options) {
    const options = f.options;
    const values = valueCounts(cells)
      .slice(0, 20)
      .map((v) => ({
        value: v.value.slice(0, VALUE_MAX),
        count: v.count,
        to: optionOf(v.value, options),
      }));
    const labels = Object.fromEntries(options.map((o) => [o.value, o.label]));
    return { ...base, values, entry: { from, transform: { kind: 'enum', options: { labels } } } };
  }
  if (f && isDateField(f)) {
    const read = readDates(cells);
    const date = read ?? { format: null, choices: [], parsed: 0, total: cells.length };
    const output = f.format === 'date' ? 'date' : 'iso';
    // An empty column still maps; a D/M/Y clash waits for a choice.
    const input = read ? read.format : 'auto';
    return {
      ...base,
      date,
      entry: input ? { from, transform: { kind: 'date', options: { input, output } } } : null,
    };
  }
  return { ...base, entry: { from } };
}

/**
 * Suggests a column for each target: the holder email, the external ID, then every input in form
 * order. `columns` are the file's headers; `samples` are rows of cells in the same order.
 */
export function suggestMapping(
  schema: unknown,
  columns: readonly string[],
  samples: readonly (readonly string[])[],
  options: SuggestOptions = {},
): MappingSuggestion {
  const cols: Column[] = columns.map((label, i) => ({
    pointer: pointerOfKey(label),
    label,
    values: samples.map((r) => (r[i] ?? '').trim()).filter((v) => v !== ''),
  }));
  const targets = targetsOf(schema);
  const picks = new Map<string, Pick | null>();
  const keyOf = (t: Target) => `${t.role}:${t.key}`;
  for (const t of targets) picks.set(keyOf(t), byName(t, cols));
  for (const t of targets) if (!picks.get(keyOf(t))) picks.set(keyOf(t), byJoin(t, cols));
  const taken = new Set([...picks.values()].flatMap((p) => p?.from ?? []));
  for (const t of targets) {
    if (picks.get(keyOf(t))) continue;
    const pick = byValues(t, cols, taken);
    picks.set(keyOf(t), pick);
    for (const p of pick?.from ?? []) taken.add(p);
  }

  // External ID follows the template's ID input unless a column is named External ID outright.
  const idKey = idInputOf(schema, options.idInput);
  const idPick = idKey ? picks.get(`input:${idKey}`) : null;
  const ownId = picks.get('externalId:externalId');
  const shared = idPick?.from.length === 1 && ownId?.confidence !== 'exact';
  if (shared && idPick) picks.set('externalId:externalId', idPick);

  const fields = targets.map((t) => suggestionOf(t, picks.get(keyOf(t)) ?? null, cols));
  const matchKey = shared ? `input:${idKey}` : 'externalId:externalId';
  for (const [i, t] of targets.entries()) {
    const s = fields[i] as MappingFieldSuggestion;
    if (keyOf(t) === matchKey && s.from.length) s.matchBy = true;
  }

  const used = new Set(
    fields.flatMap((s) => [...s.from, ...((s.entry?.transform?.options?.with as string[]) ?? [])]),
  );
  return {
    fields,
    unused: cols
      .filter((c) => !used.has(c.pointer))
      .map((c) => ({ pointer: c.pointer, label: c.label })),
    columns: cols.length,
    used: cols.filter((c) => used.has(c.pointer)).length,
    missing: targets
      .filter((t, i) => t.required && !t.field?.hasDefault && !fields[i]?.entry)
      .map((t) => t.key),
  };
}

/** The import plan a suggestion stands for; match on External ID when one is mapped. */
export function planOfSuggestion(s: MappingSuggestion): {
  mapping: Record<string, Entry>;
  holderEmail: Entry | null;
  externalId: Entry | null;
  match: 'externalId' | 'email' | 'none';
} {
  const own = (role: string) => s.fields.find((f) => f.role === role)?.entry ?? null;
  const mapping: Record<string, Entry> = {};
  for (const f of s.fields) if (f.role === 'input' && f.entry) mapping[f.target] = f.entry;
  const externalId = own('externalId');
  const holderEmail = own('holderEmail');
  return {
    mapping,
    holderEmail,
    externalId,
    match: externalId ? 'externalId' : holderEmail ? 'email' : 'none',
  };
}
