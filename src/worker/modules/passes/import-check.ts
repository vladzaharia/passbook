import { applyDefaults, inputChecker } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { PASS_IMPORT_MAX_CELL } from '../../../shared/contracts/pass-imports.ts';
import type { ParsedCsv } from '../../../shared/csv/parse.ts';
import { strictEmail } from '../../../shared/email.ts';
import { applyMapping } from '../../../shared/mapping/transform.ts';
import { accessInputIssues } from './access-input.ts';
import { coerceInput } from './import-coerce.ts';
import {
  IMPORT_TEXT,
  type ImportProblem,
  inputMessage,
  labelOf,
  problem,
  shown,
} from './import-messages.ts';
import { headerOf, type ImportPlan, recordOf, withOverrides } from './import-plan.ts';

/** A row after the checks that need no database; `input` is null when the row could not be mapped. */
export interface CheckedRow {
  row: number;
  externalId: string | null;
  holderEmail: string | null;
  input: Personalization | null;
  /** Cells the plan's enum or date step could not read, as written (200 characters): kept with the row's input, not in it. */
  raw?: Record<string, string>;
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
      const label = name === '' ? '' : labelOf(props[name], name);
      out.push(
        problem(row, {
          column: columnOf(name),
          field: name || null,
          label: label || null,
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
            label: issue.path ? labelOf(props[issue.path], issue.path) : null,
            code: issue.code ?? 'ACCESS_INPUT',
            message: issue.message,
          }),
        );
    return out;
  };
}

const READ_KEYWORD = { enum: 'enum', date: 'format' } as const;

/**
 * A cell the plan's enum or date step could not read is dropped by the transform, which would let the
 * template's default stand in for it. Say so instead, in the input's own words.
 */
function unreadValues(
  row: number,
  rc: RowCheckContext,
  record: Record<string, Json>,
  input: Personalization,
  raw: Record<string, string>,
): ImportProblem[] {
  const props = (rc.manifest.inputs.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: ImportProblem[] = [];
  for (const [field, entry] of Object.entries(rc.plan.mapping)) {
    const kind = entry.transform?.kind;
    if (kind !== 'enum' && kind !== 'date') continue;
    const column = headerOf(entry.from, rc.header);
    const cell = column === null ? undefined : record[column];
    if (cell === undefined || input[field] !== undefined) continue;
    const text = shown(cell);
    if (text !== null) raw[field] = text.slice(0, 200);
    out.push(
      problem(row, {
        column,
        field,
        label: labelOf(props[field], field),
        code: kind === 'enum' ? 'IMPORT_OPTION_UNKNOWN' : 'IMPORT_DATE_UNREADABLE',
        message: inputMessage(
          { keyword: READ_KEYWORD[kind], message: '' },
          labelOf(props[field], field),
          props[field],
        ),
      }),
    );
  }
  return out;
}

/** Shape, map, coerce, per-key input checks, email and keys (design §8, steps 1-7); the whole-input checks follow the match. */
export function checkRows(rows: ParsedCsv['rows'], rc: RowCheckContext): CheckedRow[] {
  const { plan, header } = rc;
  const checkInputs = rowChecker(rc);
  const seen = new Map<string, number>();
  const matchKey =
    plan.match === 'externalId' ? 'externalId' : plan.match === 'email' ? 'email' : null;

  return rows.map(({ row, cells: raw }): CheckedRow => {
    const problems: ImportProblem[] = [];
    const rawCells: Record<string, string> = {};
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
      raw: rawCells,
      problems,
    });

    // 1. Shape. A row wider or narrower than the header is refused before mapping.
    if (raw.length !== header.length) {
      add({
        code: 'IMPORT_ROW_SHAPE',
        message: IMPORT_TEXT.rowShape(raw.length, header.length),
      });
      return out(null, null, null);
    }
    const cells = withOverrides(plan, header, row, raw);
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
    problems.push(...unreadValues(row, rc, record, input, rawCells));
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
