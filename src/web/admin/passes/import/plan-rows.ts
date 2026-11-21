import type { z } from 'zod';
import type { PassImportDto, PassImportPlanSchema } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import type { SourceField, TargetField } from '../../mapping/mapping.ts';
import {
  autoMap,
  fromRows,
  type Mapping,
  type MappingRow,
  toRows,
  withPinned,
} from '../../mapping/mapping.ts';

export type ImportPlan = z.input<typeof PassImportPlanSchema>;
export type Match = ImportPlan['match'];

const PIN_EMAIL = '$holderEmail';
const PIN_ID = '$externalId';
/** The two fixed rows above the template's inputs. */
export const PINNED: readonly TargetField[] = [
  { key: PIN_EMAIL, label: C.match.holderEmail, required: false },
  { key: PIN_ID, label: C.match.externalId, required: false },
];

const EMAIL_COLUMN = /^e-?mail( address)?$/i;
/** External ID columns, most explicit first: a Member ID column also feeds the template's own ID input. */
const ID_COLUMNS = [/^external[ _-]?id$/i, /^(reference|ref)$/i, /^id$/i, /^member[ _-]?id$/i];

export const sourcesOf = (imp: PassImportDto): SourceField[] =>
  imp.columns.map((c) => ({
    pointer: c.pointer,
    label: c.label,
    ...(c.samples[0] === undefined ? {} : { preview: c.samples[0] }),
  }));

/** The saved plan as editor rows; with no plan, columns named like a field fill themselves. */
export function rowsOfImport(imp: PassImportDto, targets: readonly TargetField[]): MappingRow[] {
  const plan = imp.plan;
  const sources = sourcesOf(imp);
  // A joined column has no row in this editor yet (I5).
  const mapping = {
    ...(plan?.holderEmail ? { [PIN_EMAIL]: plan.holderEmail } : {}),
    ...(plan?.externalId ? { [PIN_ID]: plan.externalId } : {}),
    ...(plan?.mapping ?? {}),
  } as Mapping;
  const rows = withPinned(toRows(mapping), PINNED);
  if (plan) return rows;
  const fill = (rs: MappingRow[], key: string, patterns: readonly RegExp[]) => {
    const source = patterns
      .map((p) => sources.find((x) => p.test(x.label ?? x.pointer)))
      .find((x) => x !== undefined);
    return source
      ? rs.map((r) => (r.input === key && !r.from ? { ...r, from: source.pointer } : r))
      : rs;
  };
  return autoMap(fill(fill(rows, PIN_ID, ID_COLUMNS), PIN_EMAIL, [EMAIL_COLUMN]), targets, sources);
}

export interface PlanResult {
  plan?: ImportPlan;
  /** Row id to message, for the editor. */
  errors: Record<string, string>;
  /** About the match choice. */
  matchError?: string;
}

/** Editor rows and the match choice to the API plan; a match on an unmapped column is refused here. */
export function planOfRows(
  rows: MappingRow[],
  settings: { match: Match; keepManual: boolean; save: boolean },
): PlanResult {
  const { mapping, errors } = fromRows(rows, PINNED);
  const { [PIN_EMAIL]: holderEmail, [PIN_ID]: externalId, ...inputs } = mapping;
  if (Object.keys(errors).length) return { errors };
  if (settings.match === 'externalId' && !externalId)
    return { errors, matchError: C.match.needExternalId };
  if (settings.match === 'email' && !holderEmail) return { errors, matchError: C.match.needEmail };
  return {
    errors,
    plan: {
      mapping: inputs,
      holderEmail: holderEmail ?? null,
      externalId: externalId ?? null,
      match: settings.match,
      keepManual: settings.match === 'none' ? false : settings.keepManual,
      save: settings.save,
    },
  };
}
