import { applyDefaults, inputChecker } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { PASS_IMPORT_MAX_CELL } from '../../../shared/contracts/pass-imports.ts';
import type { ParsedCsv } from '../../../shared/csv/parse.ts';
import { strictEmail } from '../../../shared/email.ts';
import { applyMapping } from '../../../shared/mapping/transform.ts';
import { accessInputIssues } from './access-input.ts';
import { coerceInput } from './import-coerce.ts';
import { IMPORT_TEXT, type ImportProblem, inputMessage, problem } from './import-messages.ts';
import { headerOf, type ImportPlan, recordOf } from './import-plan.ts';

/** A row after the checks that need no database; `input` is null when the row could not be mapped. */
export interface CheckedRow {
  row: number;
  externalId: string | null;
  holderEmail: string | null;
  input: Personalization | null;
  problems: ImportProblem[];
}

export interface RowCheckContext {
  manifest: TemplateManifest;
  plan: ImportPlan;
  header: readonly string[];
  zoneKeys: ReadonlySet<string>;
}

const KEY_LABEL = { externalId: 'External ID', email: 'Email' } as const;
/** The API's `externalId` limit (contracts/passes.ts). */
const MAX_EXTERNAL_ID = 200;

export const isError = (p: ImportProblem): boolean => p.severity === 'error';

/**
 * The template's input checks, worded per row. `keys` checks each mapped value on its own (type, range,
 * enum, format): all that can be said before the row's pass is known. `full` adds what needs the whole
 * input (required inputs, cross-field rules, access cards): run it on a create's input, or on an
 * update's merged result, so unmapped required fields never fail an update.
 */
export function rowChecker(rc: RowCheckContext) {
  const { manifest, plan, header } = rc;
  const check = inputChecker(manifest);
  const props = (manifest.inputs.properties ?? {}) as Record<string, Record<string, unknown>>;
  const columnOf = (field: string): string | null => {
    const entry = plan.mapping[field];
    return entry ? headerOf(entry.from, header) : null;
  };
  return (row: number, input: Personalization, scope: 'keys' | 'full'): ImportProblem[] => {
    const out: ImportProblem[] = [];
    for (const issue of check(input)) {
      const required = issue.keyword === 'required';
      const name = required
        ? (/required property "([^"]+)"/.exec(issue.message)?.[1] ?? '')
        : (issue.path ?? '');
      if (scope === 'keys' && (required || name === '')) continue;
      const label = typeof props[name]?.title === 'string' ? (props[name].title as string) : name;
      out.push(
        problem(row, {
          column: columnOf(name),
          field: name || null,
          code: issue.code,
          message: inputMessage(issue, label || 'The pass', props[name]),
        }),
      );
    }
    const access = manifest.scan?.access;
    if (scope === 'full' && access)
      for (const issue of accessInputIssues(access, applyDefaults(manifest, input), rc.zoneKeys))
        out.push(
          problem(row, {
            column: columnOf(issue.path),
            field: issue.path || null,
            code: issue.code ?? 'ACCESS_INPUT',
            message: issue.message,
          }),
        );
    return out;
  };
}

/** Shape, map, coerce, per-key input checks, email and keys (design §8, steps 1-7); the whole-input checks follow the match. */
export function checkRows(rows: ParsedCsv['rows'], rc: RowCheckContext): CheckedRow[] {
  const { plan, header } = rc;
  const checkInputs = rowChecker(rc);
  const seen = new Map<string, number>();
  const matchKey =
    plan.match === 'externalId' ? 'externalId' : plan.match === 'email' ? 'email' : null;

  return rows.map(({ row, cells }): CheckedRow => {
    const problems: ImportProblem[] = [];
    const add = (p: Parameters<typeof problem>[1]) => problems.push(problem(row, p));
    const out = (
      input: Personalization | null,
      externalId: string | null,
      holderEmail: string | null,
    ) => ({
      row,
      externalId,
      holderEmail,
      input,
      problems,
    });

    // 1. Shape. A row wider or narrower than the header is refused before mapping.
    if (cells.length !== header.length) {
      add({
        code: 'IMPORT_ROW_SHAPE',
        message: IMPORT_TEXT.rowShape(cells.length, header.length),
      });
      return out(null, null, null);
    }
    const long = cells.findIndex((c) => c.length > PASS_IMPORT_MAX_CELL);
    if (long >= 0) {
      add({
        column: header[long] ?? null,
        code: 'IMPORT_CELL_TOO_LONG',
        message: IMPORT_TEXT.cellTooLong(header[long] ?? 'A cell'),
      });
      return out(null, null, null);
    }

    // 2-4. Map, read the text as the input types, check each value on its own. A blank cell is unset.
    const record = recordOf(header, cells);
    const input = coerceInput(rc.manifest.inputs, applyMapping(plan.mapping, record));
    problems.push(...checkInputs(row, input, 'keys'));

    // 6. Holder email.
    let holderEmail: string | null = null;
    const mappedEmail = plan.holderEmail
      ? applyMapping({ holderEmail: plan.holderEmail }, record).holderEmail
      : undefined;
    const emailColumn = plan.holderEmail ? headerOf(plan.holderEmail.from, header) : null;
    if (mappedEmail !== undefined) {
      holderEmail = strictEmail(mappedEmail);
      if (holderEmail === null)
        add({
          column: emailColumn,
          field: 'holderEmail',
          code: 'EMAIL_INVALID',
          message: IMPORT_TEXT.emailInvalid,
        });
    }

    // 7. External ID: always unique in the file and at most 200 characters; empty only matters as the key.
    const mappedId = plan.externalId
      ? applyMapping({ externalId: plan.externalId }, record).externalId
      : undefined;
    const externalId: string | null = mappedId === undefined ? null : String(mappedId as Json);
    const idColumn = plan.externalId ? headerOf(plan.externalId.from, header) : null;
    const keyed = [
      ['externalId', externalId, mappedId === undefined, idColumn, 'externalId'],
      ['email', holderEmail, mappedEmail === undefined, emailColumn, 'holderEmail'],
    ] as const;
    for (const [kind, value, empty, column, field] of keyed) {
      if (kind === 'externalId' && externalId !== null && externalId.length > MAX_EXTERNAL_ID)
        add({
          column,
          field,
          code: 'IMPORT_KEY_TOO_LONG',
          message: IMPORT_TEXT.keyTooLong(KEY_LABEL[kind]),
        });
      if (empty && matchKey === kind)
        add({
          column,
          field,
          code: 'IMPORT_KEY_MISSING',
          message: IMPORT_TEXT.keyMissing(KEY_LABEL[kind]),
        });
      if (empty || value === null || (kind === 'email' && matchKey !== 'email')) continue;
      const first = seen.get(`${kind}:${value}`);
      if (first === undefined) seen.set(`${kind}:${value}`, row);
      else
        add({
          column,
          field,
          code: 'IMPORT_DUPLICATE_KEY',
          message: IMPORT_TEXT.duplicateKey(
            KEY_LABEL[kind],
            kind === 'email' ? null : value,
            first,
          ),
        });
    }
    return out(input, externalId, holderEmail);
  });
}
