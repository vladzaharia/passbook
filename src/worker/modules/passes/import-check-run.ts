import type { TemplateManifest } from '../../../passkit/types.ts';
import type { MappingSuggestion } from '../../../shared/contracts/issuing.ts';
import { suggestMapping } from '../../../shared/issuing/matcher.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgEmailBudget } from '../delivery/repo-email-budget.ts';
import { resolveTemplate } from './builder.ts';
import { effectiveApiRelease } from './create-release.ts';
import type { TenantPassWrite } from './http.ts';
import { type CheckedRow, checkRows, rowChecker } from './import-check.ts';
import { rememberPlan } from './import-mappings.ts';
import { type PlannedRow, planRows, summarize } from './import-match.ts';
import { type ImportPlan, missingColumns, parsePlan, planProblems } from './import-plan.ts';
import { parseImport } from './import-source.ts';
import { activeZoneKeys } from './repo-access-zones.ts';
import { createdRowNumbers, insertRows, type RowInsert, rowCounts } from './repo-import-rows.ts';
import { beginCheck, beginRecheck, finishCheck, type ImportRow } from './repo-imports.ts';

export async function loadFile(ctx: ServiceContext, imp: ImportRow) {
  const object = imp.object_key ? await ctx.env.BUCKET.get(imp.object_key) : null;
  if (!object) throw new AppError('IMPORT_FILE_GONE', 410, 'The file is gone. Upload it again.');
  return parseImport(new Uint8Array(await object.arrayBuffer()));
}

export async function template(ctx: ServiceContext, a: TenantPassWrite, templateId: string) {
  const release = await effectiveApiRelease(ctx, { orgId: a.orgId, templateId, mode: a.mode });
  return { release, template: await resolveTemplate(ctx, a.orgId, templateId, release.version) };
}

export function assertPlan(
  plan: ImportPlan,
  manifest: TemplateManifest,
  header: readonly string[],
): void {
  const problems = planProblems(plan, manifest);
  if (problems.length > 0)
    throw new ValidationError(
      'The column mapping is not valid.',
      problems.map((message) => ({ path: 'plan', message })),
      'IMPORT_PLAN_INVALID',
    );
  const missing = missingColumns(plan, header);
  if (missing.length > 0)
    throw new ValidationError(
      `The file has no "${missing[0]}" column.`,
      [],
      'IMPORT_COLUMN_MISSING',
    );
}

const rowOf = (r: PlannedRow): RowInsert => ({
  row: r.row,
  action: r.action,
  passId: r.passId,
  expectedVersion: r.expectedVersion,
  externalId: r.externalId,
  holderEmail: r.holderEmail,
  input: r.input ? JSON.stringify(r.input) : null,
  problems: r.problems.length > 0 ? JSON.stringify(r.problems) : null,
});

const sameWithoutFixes = (a: ImportPlan, b: ImportPlan): boolean =>
  JSON.stringify({ ...a, overrides: undefined }) === JSON.stringify({ ...b, overrides: undefined });

/**
 * Rows whose check differs between the last plan and this one. A fix to one cell changes that row, and
 * any row that shares its key (a duplicate flips on the later row), so both are found by running the
 * file's own checks, which read no database, under each plan and comparing the rows they produce.
 */
function dirtyRows(
  parsed: ReturnType<typeof parseImport>,
  rc: Parameters<typeof checkRows>[1],
  last: ImportPlan,
  now: readonly CheckedRow[],
): CheckedRow[] {
  const before = checkRows(parsed.rows, { ...rc, plan: last });
  return now.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i]));
}

/**
 * Checks the file against the plan and writes only the draft's own rows (design D2). When only the
 * cell fixes changed since the last check of the same file and release, only the rows those fixes
 * touch are looked up and rewritten; the rest keep their checked state, and the counts are read back.
 */
export async function runCheck(
  ctx: ServiceContext,
  a: TenantPassWrite,
  imp: ImportRow,
  plan: ImportPlan,
): Promise<void> {
  const parsed = await loadFile(ctx, imp);
  const { release, template: tpl } = await template(ctx, a, imp.template_id);
  assertPlan(plan, tpl.manifest, parsed.header);
  const zones = tpl.manifest.scan?.access?.input.zones;
  const zoneKeys = new Set(zones === undefined ? [] : await activeZoneKeys(ctx.env.DB, a.orgId));
  const rc = { manifest: tpl.manifest, plan, header: parsed.header, zoneKeys };
  const checkInputs = rowChecker(rc);
  const scope = { orgId: a.orgId, mode: a.mode, templateId: imp.template_id };
  const checked = checkRows(parsed.rows, rc);
  const last = imp.state === 'ready' ? parsePlan(imp.plan, ctx.log) : null;
  const made = new Set(await createdRowNumbers(ctx.env.DB, imp.id));
  const partial =
    last !== null &&
    made.size === 0 &&
    imp.release_id === release.id &&
    imp.release_generation === release.generation &&
    sameWithoutFixes(last, plan);
  const todo = partial ? dirtyRows(parsed, rc, last, checked) : checked;
  const planned = (
    await planRows(
      ctx.env.DB,
      scope,
      plan,
      tpl.manifest,
      todo,
      (row, input) => checkInputs(row, input, 'full'),
      ctx.log,
    )
  ).filter((r) => !made.has(r.row));
  const checkId = ctx.ids.id();
  const start = {
    checkId,
    plan: JSON.stringify(plan),
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    emailBudget: await orgEmailBudget(ctx.env.DB, a.mode, a.orgId, ctx.clock.now()),
  };
  if (partial)
    await beginRecheck(
      ctx,
      a,
      imp.id,
      start,
      planned.map((r) => r.row),
    );
  else await beginCheck(ctx, a, imp.id, start);
  await insertRows(ctx, a, imp.id, checkId, planned.map(rowOf));
  const summary = partial ? await rowCounts(ctx.env.DB, imp.id) : summarize(planned);
  await finishCheck(ctx, a, imp.id, checkId, summary);
  if (plan.save) await rememberPlan(ctx, a, imp.template_id, plan);
  ctx.log.info('pass_import.checked', {
    orgId: a.orgId,
    importId: imp.id,
    rechecked: partial ? planned.length : undefined,
    ...summary,
  });
}

/** Rows the suggestion reads: enough to see a column's values, bounded for a 2,000-row file. */
const SUGGEST_ROWS = 500;

export const suggestOf = (
  manifest: TemplateManifest,
  parsed: ReturnType<typeof parseImport>,
): MappingSuggestion =>
  suggestMapping(
    manifest.inputs,
    parsed.header,
    parsed.rows.slice(0, SUGGEST_ROWS).map((r) => r.cells),
    { idInput: manifest.scan?.lookup?.input },
  );

/** The template's suggestion for a draft still being mapped; none once it ran, expired or lost its file. */
export async function suggestionFor(
  ctx: ServiceContext,
  a: TenantPassWrite,
  imp: ImportRow,
): Promise<MappingSuggestion | undefined> {
  if (!['mapping', 'ready', 'stale'].includes(imp.state) || imp.expires_at <= ctx.clock.now())
    return undefined;
  try {
    const parsed = await loadFile(ctx, imp);
    return suggestOf((await template(ctx, a, imp.template_id)).template.manifest, parsed);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass_import.suggestion_unavailable', {
      code: 'IMPORT_SUGGESTION_UNAVAILABLE',
      importId: imp.id,
      error,
    });
    return undefined;
  }
}
