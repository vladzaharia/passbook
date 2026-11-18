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

/** Pointers of the plan that name no column of the file. */
export function missingColumns(plan: ImportPlan, header: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const e of entriesOf(plan))
    if (usesColumn(e) && headerOf(e.from, header) === null) missing.add(e.from);
  return [...missing];
}

/** A saved plan with the entries for missing columns removed; matching falls back to "none" when its key went. */
export function withoutColumns(plan: ImportPlan, header: readonly string[]): ImportPlan {
  const keep = (e: Entry | null): Entry | null =>
    e && (!usesColumn(e) || headerOf(e.from, header) !== null) ? e : null;
  const mapping = Object.fromEntries(
    Object.entries(plan.mapping).filter(([, e]) => keep(e) !== null),
  );
  const holderEmail = keep(plan.holderEmail);
  const externalId = keep(plan.externalId);
  const match =
    (plan.match === 'externalId' && !externalId) || (plan.match === 'email' && !holderEmail)
      ? 'none'
      : plan.match;
  return { ...plan, mapping, holderEmail, externalId, match };
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

/** The stored plan, or null when the JSON no longer parses (the schema moved on). */
export function parsePlan(json: string | null): ImportPlan | null {
  if (json === null) return null;
  try {
    const parsed = PassImportPlanSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
