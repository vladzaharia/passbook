import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import {
  type PassImportColumnSchema,
  PassImportPlanSchema,
} from '../../../shared/contracts/pass-imports.ts';
import type { ParsedCsv } from '../../../shared/csv/parse.ts';
import { normalizePointer } from '../../../shared/mapping/pointer.ts';
import { mappingIssues } from '../../../shared/mapping/transform.ts';
import type { Logger } from '../../platform/log.ts';

export type ImportPlan = z.infer<typeof PassImportPlanSchema>;
export type ImportColumn = z.infer<typeof PassImportColumnSchema>;
export type ImportRecord = Record<string, Json>;

/** The pointer a header is addressed by: `/` plus the RFC 6901-escaped name. */
export const pointerOfHeader = (header: string): string =>
  `/${header.replaceAll('~', '~0').replaceAll('/', '~1')}`;

export function columnsOf(parsed: ParsedCsv): ImportColumn[] {
  return parsed.header.map((label, i) => ({
    pointer: pointerOfHeader(label),
    label: label.slice(0, 200),
    samples: parsed.rows
      .map((r) => (r.cells[i] ?? '').trim())
      .filter((v) => v !== '')
      .slice(0, 3)
      .map((v) => v.slice(0, 80)),
  }));
}

/** A row as a record keyed by header. Blank cells are left out; `null`-prototype so a header like `__proto__` is just a key. */
export function recordOf(header: readonly string[], cells: readonly string[]): ImportRecord {
  const record: ImportRecord = Object.create(null);
  header.forEach((h, i) => {
    const value = (cells[i] ?? '').trim();
    if (value !== '') record[h] = value;
  });
  return record;
}

type Entry = NonNullable<ImportPlan['holderEmail']>;

function entriesOf(plan: ImportPlan): Entry[] {
  return [
    ...Object.values(plan.mapping),
    ...(plan.holderEmail ? [plan.holderEmail] : []),
    ...(plan.externalId ? [plan.externalId] : []),
  ];
}

const usesColumn = (e: Entry) => e.transform?.kind !== 'constant';

/** The header a pointer addresses, or null when the file has no such column. */
export function headerOf(from: string, header: readonly string[]): string | null {
  const pointer = normalizePointer(from);
  return header.find((h) => pointerOfHeader(h) === pointer) ?? null;
}

/** The column pointers an entry reads: `from`, and a join's other columns. */
function pointersOf(e: Entry): string[] {
  const more = e.transform?.kind === 'join' ? e.transform.options?.with : undefined;
  return [e.from, ...(Array.isArray(more) ? more.filter((p) => typeof p === 'string') : [])];
}

/** Pointers of the plan that name no column of the file. */
export function missingColumns(plan: ImportPlan, header: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const e of entriesOf(plan))
    if (usesColumn(e))
      for (const p of pointersOf(e)) if (headerOf(p, header) === null) missing.add(p);
  return [...missing];
}

/** A row's cells with the fixes made in the check laid over them. */
export function withOverrides(
  plan: ImportPlan,
  header: readonly string[],
  row: number,
  cells: readonly string[],
): readonly string[] {
  const fixes = plan.overrides?.[String(row)];
  if (!fixes) return cells;
  const next = [...cells];
  for (const [pointer, value] of Object.entries(fixes)) {
    const h = headerOf(pointer, header);
    const i = h === null ? -1 : header.indexOf(h);
    if (i >= 0) next[i] = value;
  }
  return next;
}

/** The column of the plan's match key (External ID or Email) when the file lacks it; matching cannot silently turn off. */
export function missingKeyColumn(plan: ImportPlan, header: readonly string[]): string | null {
  const entry =
    plan.match === 'externalId'
      ? plan.externalId
      : plan.match === 'email'
        ? plan.holderEmail
        : null;
  return entry && usesColumn(entry) && headerOf(entry.from, header) === null ? entry.from : null;
}

/** A saved plan with the entries for missing columns removed (call `missingKeyColumn` first: the match key stays). */
export function withoutColumns(plan: ImportPlan, header: readonly string[]): ImportPlan {
  const keep = (e: Entry | null): Entry | null =>
    e && (!usesColumn(e) || pointersOf(e).every((p) => headerOf(p, header) !== null)) ? e : null;
  const mapping = Object.fromEntries(
    Object.entries(plan.mapping).filter(([, e]) => keep(e) !== null),
  );
  return {
    ...plan,
    mapping,
    holderEmail: keep(plan.holderEmail),
    externalId: keep(plan.externalId),
  };
}

/** Structural problems of a plan against the template's inputs; empty when usable. */
export function planProblems(plan: ImportPlan, manifest: TemplateManifest): string[] {
  const props = (manifest.inputs.properties ?? {}) as Record<string, unknown>;
  const problems = mappingIssues(plan.mapping).map((i) => `${i.path}: ${i.message}`);
  for (const key of Object.keys(plan.mapping))
    if (!Object.hasOwn(props, key))
      problems.push(`mapping.${key}: The template has no such input.`);
  const keys: Record<string, Entry> = {};
  if (plan.holderEmail) keys.holderEmail = plan.holderEmail;
  if (plan.externalId) keys.externalId = plan.externalId;
  problems.push(...mappingIssues(keys).map((i) => `${i.path}: ${i.message}`));
  return problems;
}

/** The stored plan, or null when the JSON no longer parses (the schema moved on); logged, never silent. */
export function parsePlan(json: string | null, log: Logger): ImportPlan | null {
  if (json === null) return null;
  try {
    const parsed = PassImportPlanSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: logged below like a plan the schema refuses.
  }
  log.warn('pass_import.plan_unreadable', { code: 'IMPORT_PLAN_UNREADABLE' });
  return null;
}
