import { applyDefaults, inputChecker } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { PASS_IMPORT_MAX_CELL } from '../../../shared/contracts/pass-imports.ts';
import type { ParsedCsv } from '../../../shared/csv/parse.ts';
import { strictEmail } from '../../../shared/email.ts';
import { applyMapping } from '../../../shared/mapping/transform.ts';
import { accessInputIssues } from './access-input.ts';
import { coerceInput } from './import-coerce.ts';
import { IMPORT_TEXT, type ImportProblem, inputMessage } from './import-messages.ts';
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

export const isError = (p: ImportProblem): boolean => p.severity === 'error';

/** Shape, map, coerce, template input, access input, email and key, in that order (design §8, steps 1-7). */
export function checkRows(rows: ParsedCsv['rows'], rc: RowCheckContext): CheckedRow[] {
  const { manifest, plan, header } = rc;
  const check = inputChecker(manifest);
  const props = (manifest.inputs.properties ?? {}) as Record<string, Record<string, unknown>>;
  const columnOf = (field: string): string | null => {
    const entry = plan.mapping[field];
    return entry ? headerOf(entry.from, header) : null;
  };
  const seen = new Map<string, number>();
  const keyOf =
    plan.match === 'externalId' ? 'externalId' : plan.match === 'email' ? 'email' : null;

  return rows.map(({ row, cells }): CheckedRow => {
    const problems: ImportProblem[] = [];
    const add = (
      p: Omit<ImportProblem, 'row' | 'severity'> & { severity?: ImportProblem['severity'] },
    ) => problems.push({ row, severity: 'error', ...p, message: p.message.slice(0, 200) });
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
        column: null,
        field: null,
        code: 'IMPORT_ROW_SHAPE',
        message: IMPORT_TEXT.rowShape(cells.length, header.length),
      });
      return out(null, null, null);
    }
    const long = cells.findIndex((c) => c.length > PASS_IMPORT_MAX_CELL);
    if (long >= 0) {
      add({
        column: header[long] ?? null,
        field: null,
        code: 'IMPORT_CELL_TOO_LONG',
        message: IMPORT_TEXT.cellTooLong(header[long] ?? 'A cell'),
      });
      return out(null, null, null);
    }

    // 2-3. Map, then read the text as the input types.
    const record = recordOf(header, cells);
    const input = coerceInput(manifest.inputs, applyMapping(plan.mapping, record));

    // 4. The template's own input check, one sentence each.
    for (const issue of check(input)) {
      const name =
        issue.keyword === 'required'
          ? (/required property "([^"]+)"/.exec(issue.message)?.[1] ?? '')
          : (issue.path ?? '');
      const label = typeof props[name]?.title === 'string' ? (props[name].title as string) : name;
      add({
        column: columnOf(name),
        field: name || null,
        code: issue.code,
        message: inputMessage(issue, label || 'The pass', props[name]),
      });
    }

    // 5. Access cards: plan, zones, window, visits.
    const access = manifest.scan?.access;
    if (access)
      for (const issue of accessInputIssues(access, applyDefaults(manifest, input), rc.zoneKeys))
        add({
          column: columnOf(issue.path),
          field: issue.path || null,
          code: issue.code ?? 'ACCESS_INPUT',
          message: issue.message,
        });

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

    // 7. External ID and the match key.
    const mappedId = plan.externalId
      ? applyMapping({ externalId: plan.externalId }, record).externalId
      : undefined;
    const externalId: string | null = mappedId === undefined ? null : String(mappedId as Json);
    const key = keyOf === 'email' ? holderEmail : externalId;
    if (keyOf !== null) {
      const label = KEY_LABEL[keyOf];
      const column =
        (keyOf === 'email'
          ? emailColumn
          : plan.externalId && headerOf(plan.externalId.from, header)) || null;
      const empty = keyOf === 'email' ? mappedEmail === undefined : externalId === null;
      if (empty)
        add({
          column,
          field: keyOf === 'email' ? 'holderEmail' : 'externalId',
          code: 'IMPORT_KEY_MISSING',
          message: IMPORT_TEXT.keyMissing(label),
        });
      else if (key !== null) {
        const mark = `${keyOf}:${key}`;
        const first = seen.get(mark);
        if (first === undefined) seen.set(mark, row);
        else
          add({
            column,
            field: keyOf === 'email' ? 'holderEmail' : 'externalId',
            code: 'IMPORT_DUPLICATE_KEY',
            message: IMPORT_TEXT.duplicateKey(label, keyOf === 'email' ? null : key, first),
          });
      }
    }
    return out(input, externalId, holderEmail);
  });
}
