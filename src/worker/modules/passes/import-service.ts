import type { TemplateManifest } from '../../../passkit/types.ts';
import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { bump } from '../../platform/counters.ts';
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgEmailBudget } from '../delivery/repo-email-budget.ts';
import { resolveTemplate } from './builder.ts';
import { effectiveApiRelease } from './create-release.ts';
import type { TenantPassWrite } from './http.ts';
import { checkRows, rowChecker } from './import-check.ts';
import { planRows, summarize } from './import-match.ts';
import {
  type ImportPlan,
  missingColumns,
  missingKeyColumn,
  parsePlan,
  planProblems,
  withoutColumns,
} from './import-plan.ts';
import { importDto } from './import-read.ts';
import {
  type ImportSource,
  objectKeyOf,
  parseImport,
  sha256Hex,
  sourceBytes,
  sourceName,
} from './import-source.ts';
import { activeZoneKeys } from './repo-access-zones.ts';
import { savedPlan, savePlan } from './repo-import-mappings.ts';
import { insertRows } from './repo-import-rows.ts';
import {
  beginCheck,
  discardDraft,
  failCheck,
  finishCheck,
  getImport,
  type ImportRow,
  insertImport,
  listImports,
} from './repo-imports.ts';

const HOUR = 3_600_000;
const DRAFT_TTL = 23 * HOUR;
/** Imports an org may start an hour, and checks it may run (each re-reads the file and rewrites the rows). */
const CREATES_PER_HOUR = 30;
const CHECKS_PER_HOUR = 120;
const OPEN = ['mapping', 'checking', 'ready', 'stale'];

const who = (a: TenantPassWrite) => (a.kind === 'session' ? a.userId : a.keyId);

async function enforceRate(
  ctx: ServiceContext,
  a: TenantPassWrite,
  kind: 'pass-import' | 'pass-import-check',
  cap: number,
): Promise<void> {
  const now = ctx.clock.now();
  const n = await bump(ctx.env.DB, `${kind}:${a.mode}:org:${a.orgId}`, now - (now % HOUR));
  if (n > cap) throw new RateLimitedError(3600, 'Too many imports. Try again later.');
}

async function loadFile(ctx: ServiceContext, imp: ImportRow) {
  const object = imp.object_key ? await ctx.env.BUCKET.get(imp.object_key) : null;
  if (!object) throw new AppError('IMPORT_FILE_GONE', 410, 'The file is gone. Upload it again.');
  return parseImport(new Uint8Array(await object.arrayBuffer()));
}

/** The draft of this org and mode, or 404. Nothing else of the draft is read before this. */
export async function requireImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
): Promise<ImportRow> {
  const row = await getImport(ctx.env.DB, a.orgId, a.mode, id);
  if (!row) throw new NotFoundError('Import not found.', 'IMPORT_NOT_FOUND');
  return row;
}

async function template(ctx: ServiceContext, a: TenantPassWrite, templateId: string) {
  const release = await effectiveApiRelease(ctx, { orgId: a.orgId, templateId, mode: a.mode });
  return { release, template: await resolveTemplate(ctx, a.orgId, templateId, release.version) };
}

function assertPlan(plan: ImportPlan, manifest: TemplateManifest, header: readonly string[]): void {
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

/** Checks the file against the plan and writes only the draft's own rows (design D2). */
async function runCheck(
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
  const planned = await planRows(
    ctx.env.DB,
    { orgId: a.orgId, mode: a.mode, templateId: imp.template_id },
    plan,
    tpl.manifest,
    checkRows(parsed.rows, rc),
    (row, input) => checkInputs(row, input, 'full'),
    ctx.log,
  );
  const checkId = ctx.ids.id();
  const summary = summarize(planned);
  await beginCheck(ctx, a, imp.id, {
    checkId,
    plan: JSON.stringify(plan),
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    emailBudget: await orgEmailBudget(ctx.env.DB, a.mode, a.orgId, ctx.clock.now()),
  });
  await insertRows(
    ctx,
    a,
    imp.id,
    checkId,
    planned.map((r) => ({
      row: r.row,
      action: r.action,
      passId: r.passId,
      expectedVersion: r.expectedVersion,
      externalId: r.externalId,
      holderEmail: r.holderEmail,
      input: r.input ? JSON.stringify(r.input) : null,
      problems: r.problems.length > 0 ? JSON.stringify(r.problems) : null,
    })),
  );
  await finishCheck(ctx, a, imp.id, checkId, summary);
  if (plan.save) await savePlan(ctx, a, imp.template_id, JSON.stringify(plan), who(a));
  ctx.log.info('pass_import.checked', { orgId: a.orgId, importId: imp.id, ...summary });
}

export async function createImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  body: { templateId: string; source: ImportSource; plan?: ImportPlan | undefined },
): Promise<PassImportDto> {
  await enforceRate(ctx, a, 'pass-import', CREATES_PER_HOUR);
  const { release, template: tpl } = await template(ctx, a, body.templateId);
  const bytes = await sourceBytes(ctx, body.source);
  const parsed = parseImport(bytes);
  let plan: ImportPlan | null = body.plan ?? null;
  let runnable = plan !== null;
  if (plan === null) {
    const saved = parsePlan(await savedPlan(ctx.env.DB, a.orgId, body.templateId), ctx.log);
    if (saved && planProblems(saved, tpl.manifest).length === 0) {
      const key = missingKeyColumn(saved, parsed.header);
      if (key !== null)
        throw new ValidationError(
          `The file has no "${key.replace(/^\//, '')}" column, which the saved plan finds passes by. Map the columns again.`,
          [],
          'IMPORT_COLUMN_MISSING',
        );
      runnable = missingColumns(saved, parsed.header).length === 0;
      plan = runnable ? saved : withoutColumns(saved, parsed.header);
    }
  } else {
    assertPlan(plan, tpl.manifest, parsed.header);
  }
  const id = ctx.ids.id();
  const objectKey = objectKeyOf(a.orgId, id);
  await ctx.env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: 'text/csv' } });
  const now = ctx.clock.now();
  try {
    await insertImport(ctx, a, {
      id,
      templateId: body.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      sourceKind: body.source.kind,
      sourceName: sourceName(body.source),
      objectKey,
      objectSha256: await sha256Hex(bytes),
      plan: plan ? JSON.stringify(plan) : null,
      state: 'mapping',
      createdBy: who(a),
      now,
      expiresAt: now + DRAFT_TTL,
    });
  } catch (error) {
    ctx.waitUntil(ctx.env.BUCKET.delete(objectKey));
    throw error;
  }
  // From here the draft stays: a failed check leaves it in `mapping` for a retry.
  if (plan && runnable) {
    try {
      await runCheck(ctx, a, await requireImport(ctx, a, id), plan);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The client still gets the draft id, with the reason, and can check again.
      ctx.log.warn('pass_import.check_failed', { code: error.code, importId: id });
      await failCheck(ctx, a, id, error.code).catch((e) =>
        ctx.log.warn('pass_import.fail_mark_lost', {
          code: 'IMPORT_FAIL_MARK',
          importId: id,
          error: e,
        }),
      );
    }
  }
  return importDto(ctx, await requireImport(ctx, a, id));
}

export async function checkImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
  plan: ImportPlan,
): Promise<PassImportDto> {
  const imp = await requireImport(ctx, a, id);
  if (!OPEN.includes(imp.state) || imp.expires_at <= ctx.clock.now())
    throw new ConflictError(
      imp.state === 'committing' || imp.state === 'done'
        ? 'This import already started.'
        : 'This import expired. Upload the file again.',
      imp.expires_at <= ctx.clock.now() ? 'IMPORT_EXPIRED' : 'IMPORT_STATE',
    );
  await enforceRate(ctx, a, 'pass-import-check', CHECKS_PER_HOUR);
  await runCheck(ctx, a, imp, plan);
  return importDto(ctx, await requireImport(ctx, a, id));
}

export async function discardImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
): Promise<void> {
  const imp = await requireImport(ctx, a, id);
  if (imp.state === 'committing') throw new ConflictError('This import is running.', 'IMPORT_BUSY');
  await discardDraft(ctx, a, id);
  if (imp.object_key) await ctx.env.BUCKET.delete(imp.object_key);
}

/** Recent imports, newest first; the cursor is `<createdAt>:<id>` of the last item. */
export async function listImportPage(
  ctx: ServiceContext,
  a: TenantPassWrite,
  query: { limit: number; cursor?: string | undefined },
) {
  const [createdAt, id] = (query.cursor ?? '').split(':');
  const cursor =
    createdAt && id && Number.isSafeInteger(Number(createdAt))
      ? { createdAt: Number(createdAt), id }
      : null;
  const rows = await listImports(ctx.env.DB, a.orgId, a.mode, query.limit + 1, cursor);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: await Promise.all(page.map((r) => importDto(ctx, r, { light: true }))),
    nextCursor: rows.length > query.limit && last ? `${last.created_at}:${last.id}` : null,
  };
}
