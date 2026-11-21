import type { TemplateManifest } from '../../../passkit/types.ts';
import type { MappingSuggestion } from '../../../shared/contracts/issuing.ts';
import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { planOfSuggestion } from '../../../shared/issuing/matcher.ts';
import { bump } from '../../platform/counters.ts';
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { assertPlan, runCheck, suggestOf, template } from './import-check-run.ts';
import { pickSaved, readMappings, who } from './import-mappings.ts';
import {
  type ImportPlan,
  missingColumns,
  missingKeyColumn,
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
import {
  discardDraft,
  failCheck,
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

/** The plan `mapping: 'auto'` stands for: a saved mapping of the same columns, else the template's own suggestion. */
async function autoPlan(
  ctx: ServiceContext,
  a: TenantPassWrite,
  templateId: string,
  manifest: TemplateManifest,
  parsed: ReturnType<typeof parseImport>,
): Promise<{ plan: ImportPlan | null; suggestion: MappingSuggestion }> {
  const suggestion = suggestOf(manifest, parsed);
  const saved = pickSaved((await readMappings(ctx, a.orgId, templateId)).saved, parsed.header);
  if (
    saved &&
    planProblems(saved.plan, manifest).length === 0 &&
    missingColumns(saved.plan, parsed.header).length === 0
  )
    return { plan: saved.plan, suggestion };
  const base = planOfSuggestion(suggestion);
  const plan: ImportPlan = { ...base, keepManual: false, save: true };
  const usable = Object.keys(plan.mapping).length > 0 && planProblems(plan, manifest).length === 0;
  return { plan: usable ? plan : null, suggestion };
}

export async function createImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  body: {
    templateId: string;
    source: ImportSource;
    plan?: ImportPlan | undefined;
    mapping?: 'auto' | undefined;
  },
): Promise<PassImportDto> {
  await enforceRate(ctx, a, 'pass-import', CREATES_PER_HOUR);
  const { release, template: tpl } = await template(ctx, a, body.templateId);
  const bytes = await sourceBytes(ctx, body.source);
  const parsed = parseImport(bytes);
  let plan: ImportPlan | null = body.plan ?? null;
  let runnable = plan !== null;
  let suggestion: MappingSuggestion | undefined;
  if (plan === null && body.mapping === 'auto') {
    const auto = await autoPlan(ctx, a, body.templateId, tpl.manifest, parsed);
    ({ plan, suggestion } = auto);
    runnable = plan !== null;
  } else if (plan === null) {
    const saved = (await readMappings(ctx, a.orgId, body.templateId)).last;
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
  return importDto(ctx, await requireImport(ctx, a, id), suggestion ? { mapping: suggestion } : {});
}

/** An import is terminal once an undo was asked for: it can be read, not checked, committed or discarded. */
export function assertNotUndone(imp: ImportRow): void {
  if (imp.reverted !== 0)
    throw new ConflictError('This import was undone. Upload the file again.', 'IMPORT_UNDONE');
}

export async function checkImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
  plan: ImportPlan,
): Promise<PassImportDto> {
  const imp = await requireImport(ctx, a, id);
  assertNotUndone(imp);
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
  assertNotUndone(imp);
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
