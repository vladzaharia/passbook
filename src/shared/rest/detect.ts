import type { z } from 'zod';
import type { ProbeDetectionsSchema } from '../contracts/connection-probe.ts';
import { isEmail, valueCounts } from '../issuing/matcher-values.ts';
import {
  detectRecordsArrays,
  epochUnit,
  idCandidates,
  idRank,
  timeCandidates,
  timeRank,
} from '../records/detect.ts';
import { type FieldInfo, leafFields, resolvePointer } from '../records/fields.ts';
import { detectPagination } from './detect-pagination.ts';
import { recordsJsonPath } from './json-path.ts';

export type ProbeDetections = z.infer<typeof ProbeDetectionsSchema>;
type FieldRow = ProbeDetections['fields'][number];

export interface DetectInput {
  body: unknown;
  /** Response headers by lower-case name. */
  headers: Readonly<Record<string, string>>;
  /** The request URL, for the paging parameters it already carries. */
  url: string;
  /** The records array in use or picked; it leads the candidates when it holds objects. */
  recordsPointer?: string;
  /** The ID field in use, for the has-more-with-IDs check. */
  idPointer?: string;
  /** A single-record answer: the record's pointer in the body (`''` for the whole body). */
  record?: string;
}

const ROWS = 50;
const MAX_FIELDS = 100;
const MAX_VALUES = 20;
const SAMPLE_CHARS = 80;
const BASE = { root: 0.9, name: 0.75, shape: 0.45 } as const;
const round = (n: number) => Math.round(n * 100) / 100;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Share of top-level keys the first records have in common (1: every record has the same keys). */
function homogeneity(rows: readonly unknown[]): number {
  const sets = rows
    .slice(0, 20)
    .filter(isPlain)
    .map((r) => new Set(Object.keys(r)));
  const union = new Set(sets.flatMap((s) => [...s]));
  if (union.size === 0) return 0;
  const shared = [...union].filter((k) => sets.every((s) => s.has(k)));
  return shared.length / union.size;
}

function recordCandidates(body: unknown, preferred: string | undefined) {
  const found = detectRecordsArrays(body).map((c) => {
    const rows = resolvePointer(body, c.pointer);
    const list = rows.found && Array.isArray(rows.value) ? rows.value : [];
    const reason = c.pointer === '' ? 'root' : c.hinted ? 'name' : 'shape';
    const raw = BASE[reason] * (0.5 + 0.5 * homogeneity(list)) * (1 - 0.05 * c.depth);
    return {
      pointer: c.pointer,
      count: c.length,
      score: round(raw * (c.length > 1 ? 1 : 0.85)),
      reason,
    } as const;
  });
  found.sort((a, b) => b.score - a.score);
  if (preferred === undefined) return found;
  const hit = resolvePointer(body, preferred);
  if (!hit.found || !Array.isArray(hit.value) || !hit.value.some(isPlain)) return found;
  const known = found.find((c) => c.pointer === preferred);
  const lead = known ?? {
    pointer: preferred,
    count: hit.value.length,
    score: 0.5,
    reason: preferred === '' ? ('root' as const) : ('shape' as const),
  };
  return [lead, ...found.filter((c) => c !== lead)];
}

function fieldRow(f: FieldInfo, rows: readonly unknown[], base: string): FieldRow {
  const values = rows.flatMap((r) => {
    const hit = resolvePointer(r, f.pointer);
    return hit.found && hit.value !== null && hit.value !== '' ? [hit.value] : [];
  });
  const texts = f.type === 'string' ? values.filter((v): v is string => typeof v === 'string') : [];
  const type: FieldRow['type'] =
    f.type === 'number' || f.type === 'boolean'
      ? f.type
      : f.type === 'date' || f.type === 'datetime'
        ? 'date'
        : f.type === 'array'
          ? 'list'
          : texts.length > 0 && texts.every(isEmail)
            ? 'email'
            : texts.length > 0 && texts.every((t) => /^https?:\/\//i.test(t))
              ? 'url'
              : 'text';
  const counts = type === 'text' ? valueCounts(texts) : [];
  const options =
    !f.unique &&
    texts.length >= 5 &&
    counts.length <= MAX_VALUES &&
    counts.length * 2 <= texts.length;
  return {
    pointer: f.pointer,
    jsonPath: recordsJsonPath(base, f.pointer),
    label: f.name.slice(0, 200),
    type,
    samples: f.samples.map((s) => s.slice(0, SAMPLE_CHARS)),
    ...(options
      ? { values: counts.map((c) => ({ value: c.value.slice(0, SAMPLE_CHARS), count: c.count })) }
      : {}),
  };
}

const ID_NAMED = /^(id|_id|uuid|guid|key)$/i;

function idRows(fields: FieldInfo[], base: string): ProbeDetections['id'] {
  const scores = [0.95, 0.8, 0.5, 0.3];
  const unique = idCandidates(fields).map((f) => ({
    pointer: f.pointer,
    jsonPath: recordsJsonPath(base, f.pointer),
    unique: true,
    score: scores[idRank(f.name)] ?? 0.3,
  }));
  if (unique.length > 0) return unique.slice(0, 5);
  return fields
    .filter((f) => ID_NAMED.test(f.name) && (f.type === 'string' || f.type === 'number'))
    .slice(0, 5)
    .map((f) => ({
      pointer: f.pointer,
      jsonPath: recordsJsonPath(base, f.pointer),
      unique: false,
      score: 0.2,
    }));
}

function updatedRows(fields: FieldInfo[], base: string): ProbeDetections['updatedAt'] {
  const scores = [0.95, 0.5, 0.3, 0.2];
  return timeCandidates(fields)
    .slice(0, 5)
    .map((f) => ({
      pointer: f.pointer,
      jsonPath: recordsJsonPath(base, f.pointer),
      format: f.type === 'number' ? epochUnit(f) : ('iso' as const),
      score: scores[timeRank(f.name)] ?? 0.2,
    }));
}

const int = (raw: string | undefined): number | undefined =>
  raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw) : undefined;

/** What the response says about the API's rate limit; null when it says nothing. */
export function detectRateLimit(
  headers: Readonly<Record<string, string>>,
): ProbeDetections['rateLimit'] {
  const limit = int(headers['ratelimit-limit'] ?? headers['x-ratelimit-limit']);
  const remaining = int(headers['ratelimit-remaining'] ?? headers['x-ratelimit-remaining']);
  const window = /(?:^|;)\s*w=(\d+)/.exec(headers['ratelimit-policy'] ?? '')?.[1];
  const windowSeconds = int(window ?? headers['x-ratelimit-window']);
  if (limit === undefined && remaining === undefined) return null;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(remaining === undefined ? {} : { remaining }),
  };
}

/**
 * Everything the explorer suggests for a response: the records array, the ID and updated-at fields,
 * the holder email, every field, the pagination style and the rate limit. Pure, so the browser reruns it
 * on the same body when the user picks another array.
 */
export function detectResponse(input: DetectInput): ProbeDetections {
  const records =
    input.record === undefined ? recordCandidates(input.body, input.recordsPointer) : [];
  const lead = records[0];
  const base = lead?.pointer ?? '';
  let rows: unknown[] = [];
  if (input.record !== undefined) {
    const one = resolvePointer(input.body, input.record);
    rows = one.found && isPlain(one.value) ? [one.value] : [];
  } else if (lead) {
    const hit = resolvePointer(input.body, lead.pointer);
    rows = hit.found && Array.isArray(hit.value) ? hit.value.slice(0, ROWS) : [];
  }
  const fields = leafFields(rows, { sample: ROWS }).slice(0, MAX_FIELDS);
  const rowsOut = fields.map((f) => fieldRow(f, rows, base));
  const jsonPath = (p: string) => recordsJsonPath(base, p);
  return {
    records: records.slice(0, 5).map((c) => ({ ...c, jsonPath: recordsJsonPath(c.pointer) })),
    pagination:
      input.record === undefined
        ? detectPagination({
            url: input.url,
            body: input.body,
            headers: input.headers,
            recordsPointer: lead?.pointer ?? null,
            count: lead?.count ?? 0,
            hasIds: rows.some((r) => resolvePointer(r, input.idPointer ?? '/id').found),
          })
        : [],
    id: idRows(fields, base),
    updatedAt: updatedRows(fields, base),
    holderEmail: rowsOut
      .filter((f) => f.type === 'email')
      .sort((a, b) => Number(/e-?mail/i.test(b.label)) - Number(/e-?mail/i.test(a.label)))
      .slice(0, 3)
      .map((f) => ({ pointer: f.pointer, jsonPath: jsonPath(f.pointer) })),
    fields: rowsOut,
    rateLimit: detectRateLimit(input.headers),
  };
}
