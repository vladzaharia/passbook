import { z } from 'zod';
import type { PassMatch } from '@/shared/contracts/broadcasts.ts';
import type { PassFilter } from '@/shared/contracts/pass-selection.ts';
import { strictEmail } from '@/shared/email.ts';
import { type InputField, isDateField } from '@/shared/issuing/fields.ts';

/** The query bar's chip: a field and what it must hold. Two keys are not inputs: see below. */
export const FindChipSchema = z.object({
  /** An input key, `$email` (the holder's address) or `$any` (free text, the list's `q`). */
  k: z.string().min(1).max(64),
  o: z.enum(['is', 'startsWith', 'contains']),
  v: z.string().min(1).max(120),
});
export type FindChip = z.infer<typeof FindChipSchema>;

export const EMAIL_KEY = '$email';
export const ANY_KEY = '$any';
export const MAX_FIND_CHIPS = 5;

const ChipsSchema = z.array(FindChipSchema).max(MAX_FIND_CHIPS);

/** The chips in the URL; anything malformed reads as none. */
export function parseChips(raw: string | undefined): FindChip[] {
  if (!raw) return [];
  try {
    const parsed = ChipsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const chipsParam = (chips: readonly FindChip[]): string | undefined =>
  chips.length ? JSON.stringify(chips) : undefined;

/** The list filter a set of chips means: input chips become `match`, the other two their own params. */
export function chipFilter(chips: readonly FindChip[]): {
  match?: PassMatch;
  holderEmail?: string;
  q?: string;
} {
  const match: PassMatch = [];
  const out: { holderEmail?: string; q?: string } = {};
  for (const c of chips) {
    if (c.k === EMAIL_KEY) out.holderEmail = c.v;
    else if (c.k === ANY_KEY) out.q = c.v;
    else if (c.o === 'is') match.push({ input: c.k, values: [c.v] });
    else match.push({ input: c.k, op: c.o, value: c.v });
  }
  return { ...out, ...(match.length ? { match } : {}) };
}

export interface Suggestion {
  /** Stable key for the list. */
  id: string;
  chip: FindChip;
  /** Field name in bold, then the operator words, then the typed value. */
  field: string;
  verb: string;
}

const ID_LIKE = /^[A-Za-z0-9][\w-]*\d[\w-]*$/;
const NAME_FIELD = /name/i;
const ID_FIELD = /(^|[^a-z])(id|number|no|code|serial)([^a-z]|$)|id$|number$/i;

const VERBS = { is: 'is', startsWith: 'starts with', contains: 'contains' } as const;
export const verbOf = (op: FindChip['o']): string => VERBS[op];

/** What a typed text could mean, best guess first. Always ends with "in any field". */
export function suggest(text: string, fields: readonly InputField[]): Suggestion[] {
  const t = text.trim();
  if (!t) return [];
  const out: Suggestion[] = [];
  const add = (field: string, chip: FindChip) =>
    out.push({ id: `${chip.k}:${chip.o}`, chip, field, verb: verbOf(chip.o) });
  if (strictEmail(t) !== null) add('Holder email', { k: EMAIL_KEY, o: 'is', v: t });
  const lower = t.toLowerCase();
  for (const f of fields) {
    const hit = f.options?.find(
      (o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower,
    );
    if (hit) add(f.label, { k: f.key, o: 'is', v: hit.value });
  }
  const text_ = fields.filter((f) => f.type === 'string' && !f.options && !isDateField(f));
  if (ID_LIKE.test(t)) {
    const id = text_.find((f) => ID_FIELD.test(f.key) || ID_FIELD.test(f.label));
    if (id) add(id.label, { k: id.key, o: 'startsWith', v: t });
  }
  const name = text_.find((f) => NAME_FIELD.test(f.key) || NAME_FIELD.test(f.label));
  if (name && strictEmail(t) === null) add(name.label, { k: name.key, o: 'contains', v: t });
  add('Any field', { k: ANY_KEY, o: 'startsWith', v: t });
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && seen.add(s.id)).slice(0, 4);
}

/** A chip's field name as the bar shows it. */
export function chipField(chip: FindChip, fields: readonly InputField[]): string {
  if (chip.k === EMAIL_KEY) return 'Holder email';
  if (chip.k === ANY_KEY) return 'Any field';
  return fields.find((f) => f.key === chip.k)?.label ?? chip.k;
}

/** The chip's value as shown: an option's label, not its key. */
export function chipValue(chip: FindChip, fields: readonly InputField[]): string {
  const opt = fields.find((f) => f.key === chip.k)?.options?.find((o) => o.value === chip.v);
  return opt?.label ?? chip.v;
}

/** The filter the list and a saved view share: chips plus the select filters. */
export function toPassFilter(search: {
  templateId?: string | undefined;
  status?: PassFilter['status'] | undefined;
  holderState?: PassFilter['holderState'] | undefined;
  onDevice?: 'true' | 'false' | undefined;
  noScanDays?: 30 | 90 | undefined;
  connectionId?: string | undefined;
  importId?: string | undefined;
  chips?: readonly FindChip[] | undefined;
}): PassFilter {
  const c = chipFilter(search.chips ?? []);
  return {
    ...(search.templateId ? { templateId: search.templateId } : {}),
    ...(search.connectionId ? { connectionId: search.connectionId } : {}),
    ...(search.importId ? { importId: search.importId } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(c.holderEmail ? { holderEmail: c.holderEmail } : {}),
    ...(search.holderState ? { holderState: search.holderState } : {}),
    ...(search.onDevice ? { onDevice: search.onDevice === 'true' } : {}),
    ...(search.noScanDays ? { scan: { noScanDays: search.noScanDays } } : {}),
    ...(c.q ? { q: c.q } : {}),
    ...(c.match ? { match: c.match } : {}),
  };
}

export const FIND_VIEW_CHIPS = 6;

/** The URL's search as the bar's chips: the free text (`q`) first, then the saved `m` list. */
export function allChips(search: { q?: string | undefined; m?: string | undefined }): FindChip[] {
  return [
    ...(search.q ? [{ k: ANY_KEY, o: 'startsWith' as const, v: search.q }] : []),
    ...parseChips(search.m),
  ];
}

/** Key order and `undefined` do not matter when comparing two filters. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** The list's search params for a saved filter: the inverse of `toPassFilter`. */
export function searchOfFilter(f: PassFilter) {
  const chips: FindChip[] = [];
  if (f.holderEmail) chips.push({ k: EMAIL_KEY, o: 'is', v: f.holderEmail });
  for (const c of f.match ?? []) {
    if ('values' in c && c.values[0]) chips.push({ k: c.input, o: 'is', v: c.values[0] });
    else if ('op' in c) chips.push({ k: c.input, o: c.op, v: c.value });
  }
  return {
    templateId: f.templateId,
    connectionId: f.connectionId,
    importId: f.importId,
    status: f.status,
    holderState: f.holderState,
    onDevice: f.onDevice === undefined ? undefined : (String(f.onDevice) as 'true' | 'false'),
    noScanDays: f.scan && 'noScanDays' in f.scan ? (f.scan.noScanDays as 30 | 90) : undefined,
    q: f.q,
    m: chipsParam(chips),
  };
}
