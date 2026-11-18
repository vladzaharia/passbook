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
import { checkRows } from './import-check.ts';
import { planRows, summarize } from './import-match.ts';
import {
  type ImportPlan,
  missingColumns,
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
  finishCheck,
  getImport,
  type ImportRow,
  insertImport,
} from './repo-imports.ts';

const HOUR = 3_600_000;
const DRAFT_TTL = 23 * HOUR;
/** Imports an org may start an hour. */
const CREATES_PER_HOUR = 30;
const OPEN = ['mapping', 'checking', 'ready', 'stale'];

const who = (a: TenantPassWrite) => (a.kind === 'session' ? a.userId : a.keyId);

async function enforceCreateRate(ctx: ServiceContext, a: TenantPassWrite): Promise<void> {
  const now = ctx.clock.now();
  const n = await bump(ctx.env.DB, `pass-import:${a.mode}:org:${a.orgId}`, now - (now % HOUR));
  if (n > CREATES_PER_HOUR) throw new RateLimitedError(3600, 'Too many imports. Try again later.');
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
  const checked = checkRows(parsed.rows, {
    manifest: tpl.manifest,
    plan,
    header: parsed.header,
    zoneKeys,
  });
  const planned = await planRows(
    ctx.env.DB,
    { orgId: a.orgId, mode: a.mode, templateId: imp.template_id },
    plan,
    tpl.manifest,
    checked,
  );
  const summary = summarize(planned);
  await beginCheck(ctx, a, imp.id, {
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
  await finishCheck(ctx, a, imp.id, summary);
  if (plan.save) await savePlan(ctx, a, imp.template_id, JSON.stringify(plan), who(a));
  ctx.log.info('pass_import.checked', { orgId: a.orgId, importId: imp.id, ...summary });
}

export async function createImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  body: { templateId: string; source: ImportSource; plan?: ImportPlan | undefined },
): Promise<PassImportDto> {
  await enforceCreateRate(ctx, a);
  const { release, template: tpl } = await template(ctx, a, body.templateId);
  const bytes = await sourceBytes(ctx, body.source);
  const parsed = parseImport(bytes);
  let plan: ImportPlan | null = body.plan ?? null;
  let runnable = plan !== null;
  if (plan === null) {
    const saved = parsePlan(await savedPlan(ctx.env.DB, a.orgId, body.templateId));
    if (saved && planProblems(saved, tpl.manifest).length === 0) {
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
  if (plan && runnable) await runCheck(ctx, a, await requireImport(ctx, a, id), plan);
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
