import {
  PASS_IMPORT_PREVIEWS,
  PASS_IMPORT_PROBLEMS,
  type PassImportDto,
  PassImportProblemSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { BOM, toCsv } from '../../../shared/csv/write.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ImportProblem } from './import-messages.ts';
import { columnsOf, parsePlan } from './import-plan.ts';
import { parseImport } from './import-source.ts';
import {
  emailableCount,
  errorRows,
  type ImportRowRecord,
  pageRows,
  previewRows,
  problemRows,
} from './repo-import-rows.ts';
import type { ImportRow } from './repo-imports.ts';

const EDITING = ['mapping', 'checking', 'ready', 'stale'];

function problemsOf(json: string | null): ImportProblem[] {
  if (json === null) return [];
  try {
    const parsed = PassImportProblemSchema.array().safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

async function fileOf(ctx: ServiceContext, imp: ImportRow) {
  const object = imp.object_key ? await ctx.env.BUCKET.get(imp.object_key) : null;
  return object ? parseImport(new Uint8Array(await object.arrayBuffer())) : null;
}

/** The draft as the API shows it. `light` skips the file and row reads (list pages). */
export async function importDto(
  ctx: ServiceContext,
  imp: ImportRow,
  options: { light?: boolean } = {},
): Promise<PassImportDto> {
  const db = ctx.env.DB;
  const editing = EDITING.includes(imp.state);
  const state = (
    editing && imp.expires_at <= ctx.clock.now() ? 'expired' : imp.state
  ) as PassImportDto['state'];
  const checked = imp.checked_at !== null;
  const light = options.light === true;
  const columns =
    !light && state !== 'expired' && editing
      ? ((await fileOf(ctx, imp).catch(() => null)) ?? null)
      : null;
  const previews = light || !checked ? [] : await previewRows(db, imp.id, PASS_IMPORT_PREVIEWS);
  const withProblems =
    light || !checked ? [] : await problemRows(db, imp.id, PASS_IMPORT_PROBLEMS + 1);
  const flat = withProblems.flatMap((r) => problemsOf(r.problems));
  return {
    id: imp.id,
    templateId: imp.template_id,
    templateVersion: imp.template_version,
    mode: imp.mode,
    state,
    source: { kind: imp.source_kind, name: imp.source_name },
    columns: columns ? columnsOf(columns) : [],
    plan: parsePlan(imp.plan),
    counts: checked
      ? {
          rows: imp.rows,
          create: imp.to_create,
          update: imp.to_update,
          unchanged: imp.unchanged,
          errors: imp.errors,
          warnings: imp.warnings,
          emailable: light ? 0 : await emailableCount(db, imp.id),
        }
      : null,
    previews: previews.map((p) => ({
      row: p.row_no,
      action: p.action as 'create' | 'update',
      input: p.input ? (JSON.parse(p.input) as Record<string, never>) : {},
    })),
    problems: flat.slice(0, PASS_IMPORT_PROBLEMS),
    problemsTruncated: flat.length > PASS_IMPORT_PROBLEMS,
    emailBudget: imp.email_budget,
    email: imp.email === 1,
    progress:
      imp.committed_at === null
        ? null
        : {
            done: imp.done,
            created: imp.created,
            updated: imp.updated,
            unchanged: imp.unchanged,
            failed: imp.failed,
            notEmailed: imp.not_emailed,
            removed: imp.removed,
          },
    errorCode: imp.error_code,
    errorFile: imp.errors > 0 && state !== 'discarded' && state !== 'expired',
    createdAt: imp.created_at,
    checkedAt: imp.checked_at,
    committedAt: imp.committed_at,
    finishedAt: imp.finished_at,
    expiresAt: imp.expires_at,
  };
}

/** The row page after `cursor` (a row number), 100 at a time. */
export async function rowsPage(
  ctx: ServiceContext,
  imp: ImportRow,
  query: { state?: string | undefined; cursor?: string | undefined },
) {
  const after = Number(query.cursor ?? 0);
  const rows = await pageRows(
    ctx.env.DB,
    imp.id,
    query.state,
    Number.isSafeInteger(after) ? after : 0,
    101,
  );
  const page = rows.slice(0, 100);
  return {
    items: page.map((r: ImportRowRecord) => {
      const first = problemsOf(r.problems).find((p) => p.severity === 'error');
      return {
        row: r.row_no,
        action: r.action,
        state: r.state,
        result: r.result,
        passId: r.pass_id,
        externalId: r.external_id,
        code: r.code ?? first?.code ?? null,
        message: first?.message ?? null,
        emailed: r.emailed === 1,
      };
    }),
    nextCursor: rows.length > 100 ? String(page[page.length - 1]?.row_no) : null,
  };
}

/** The uploaded columns in order, then Problem, for the rows that failed the check. */
export async function errorsCsv(ctx: ServiceContext, imp: ImportRow): Promise<string> {
  const parsed = await fileOf(ctx, imp);
  if (!parsed) throw new AppError('IMPORT_FILE_GONE', 410, 'The file is gone. Upload it again.');
  const byRow = new Map(parsed.rows.map((r) => [r.row, r.cells]));
  const out: string[][] = [];
  for (const r of await errorRows(ctx.env.DB, imp.id)) {
    const cells = byRow.get(r.row_no) ?? [];
    const text = problemsOf(r.problems)
      .filter((p) => p.severity === 'error')
      .map((p) => p.message)
      .join(' ');
    out.push([...parsed.header.map((_, i) => cells[i] ?? ''), text]);
  }
  return BOM + toCsv([...parsed.header, 'Problem'], out);
}
