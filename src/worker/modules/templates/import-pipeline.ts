import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import type { ValidationIssue, ValidationReport } from '../../../passkit/types.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateAuthority } from './access.ts';
import { dryRunReport } from './dry-run-report.ts';
import { imagesFromBinding } from './images-binding.ts';
import { persistAuthorizedStage } from './import-pipeline-persist.ts';
import {
  assertStageAuthority,
  getBytes,
  getJson,
  importAuthority,
  putJson,
  type Saved,
  stage,
} from './import-pipeline-staging.ts';
import { analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { extractArchive, ImportError } from './package/unzip.ts';
import {
  advanceImport,
  getImport,
  matchesImport,
  recordImportFailure,
  startImportRun,
} from './repo.ts';

export interface ImportParams {
  uploadId: string;
  orgId: string | null;
  objectKey: string;
  createdBy: string | null;
  authority: TemplateAuthority;
}

export interface StageResult {
  ok: boolean;
}

const behaviors = createBehaviorRegistry([...behaviorPlugins]);

/** Records a failed import. The workflow ends normally: invalid input is not retryable. */
export async function failImport(
  ctx: ServiceContext,
  p: ImportParams,
  issues: ValidationIssue[],
  code: string,
): Promise<boolean> {
  if (p.authority != null) {
    try {
      importAuthority(p);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      return false;
    }
  }
  const report: ValidationReport = { ok: false, issues };
  const recorded = await recordImportFailure(ctx.env.DB, p, report, code, ctx.clock.now());
  if (recorded) ctx.log.info('templates.import_rejected', { orgId: p.orgId, code });
  return recorded;
}

async function rejectImport(
  ctx: ServiceContext,
  p: ImportParams,
  issues: ValidationIssue[],
  code: string,
): Promise<void> {
  if (!(await failImport(ctx, p, issues, code))) throw new ForbiddenError();
}

export async function startImport(ctx: ServiceContext, p: ImportParams): Promise<void> {
  const authority = importAuthority(p);
  if (!(await startImportRun(ctx.env.DB, p, authority, ctx.clock.now())))
    throw new ForbiddenError();
}

export async function extractStage(ctx: ServiceContext, p: ImportParams): Promise<StageResult> {
  const authority = await assertStageAuthority(ctx, p);
  const zip = await ctx.env.BUCKET.get(p.objectKey);
  if (!zip) {
    await rejectImport(
      ctx,
      p,
      [
        {
          severity: 'error',
          code: 'UPLOAD_MISSING',
          message: 'The upload expired. Upload it again.',
        },
      ],
      'UPLOAD_MISSING',
    );
    return { ok: false };
  }
  try {
    const { files } = extractArchive(new Uint8Array(await zip.arrayBuffer()));
    for (const [path, bytes] of files) {
      await assertStageAuthority(ctx, p);
      await ctx.env.BUCKET.put(`${stage(p)}x/${path}`, bytes);
    }
    await assertStageAuthority(ctx, p);
    await putJson(ctx, `${stage(p)}files.json`, [...files.keys()]);
    if (!(await advanceImport(ctx.env.DB, p, authority, 'extract', 'analyze', ctx.clock.now())))
      throw new ForbiddenError();
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    await rejectImport(
      ctx,
      p,
      [{ severity: 'error', code: error.code, message: error.message }],
      error.code,
    );
    return { ok: false };
  }
}

export async function analyzeStage(
  ctx: ServiceContext,
  p: ImportParams,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
): Promise<StageResult> {
  const authority = await assertStageAuthority(ctx, p);
  const record = await getImport(ctx.env.DB, p.uploadId);
  const names = await getJson<string[]>(ctx, `${stage(p)}files.json`);
  const input = new Map<string, Uint8Array>();
  for (const name of names) input.set(name, await getBytes(ctx, `${stage(p)}x/${name}`));
  const result = await analyzePackage(input, {
    uploaded: true,
    fallbackName: record?.name ?? 'Template',
    name: record?.name ?? undefined,
    images,
    behaviors,
  });
  if (!('version' in result)) {
    await rejectImport(ctx, p, result.report.issues, 'IMPORT_INVALID');
    return { ok: false };
  }
  for (const [path, bytes] of result.files) {
    await assertStageAuthority(ctx, p);
    await ctx.env.BUCKET.put(`${stage(p)}b/${path}`, bytes);
  }
  const { files: _files, tooling, ...rest } = result;
  if (tooling) {
    await assertStageAuthority(ctx, p);
    await ctx.env.BUCKET.put(`${stage(p)}tooling.json`, tooling);
  }
  const saved: Saved = {
    name: record?.name ?? null,
    analysis: { ...rest, hasTooling: tooling !== null },
  };
  await assertStageAuthority(ctx, p);
  await putJson(ctx, `${stage(p)}analysis.json`, saved);
  if (!(await advanceImport(ctx.env.DB, p, authority, 'analyze', 'dry-run', ctx.clock.now())))
    throw new ForbiddenError();
  return { ok: true };
}

export async function dryRunStage(ctx: ServiceContext, p: ImportParams): Promise<StageResult> {
  const authority = await assertStageAuthority(ctx, p);
  const saved = await getJson<Saved>(ctx, `${stage(p)}analysis.json`);
  const a = saved.analysis;
  const report = await dryRunReport(ctx, p.orgId, { ...a, report: a.report }, (name) =>
    getBytes(ctx, `${stage(p)}b/${name}`),
  );
  if (!report.ok) {
    await rejectImport(ctx, p, report.issues, 'IMPORT_INVALID');
    return { ok: false };
  }
  await assertStageAuthority(ctx, p);
  await putJson(ctx, `${stage(p)}analysis.json`, { ...saved, analysis: { ...a, report } });
  if (!(await advanceImport(ctx.env.DB, p, authority, 'dry-run', 'persist', ctx.clock.now())))
    throw new ForbiddenError();
  return { ok: true };
}

export async function persistStage(
  ctx: ServiceContext,
  p: ImportParams,
): Promise<{ templateId: string; version: string } | null> {
  try {
    return await persistAuthorizedStage(ctx, p);
  } catch (error) {
    if (
      !(error instanceof ForbiddenError) &&
      !(
        error instanceof ConflictError &&
        (error.code === 'TEMPLATE_ARCHIVED' ||
          error.code === 'TEMPLATE_VERSION_CONFLICT' ||
          error.code === 'TEMPLATE_ASSET_CONFLICT')
      )
    ) {
      throw error;
    }
    await rejectImport(
      ctx,
      p,
      [{ severity: 'error', code: error.code, message: error.message }],
      error.code,
    );
    return null;
  }
}

/** Removes staged objects (the upload and everything under uploads/<id>/). */
export async function cleanupStage(ctx: ServiceContext, p: ImportParams): Promise<void> {
  if (!(await matchesImport(ctx.env.DB, p))) throw new ForbiddenError();
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({ prefix: stage(p), cursor, limit: 500 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) {
      if (!(await matchesImport(ctx.env.DB, p))) throw new ForbiddenError();
      await ctx.env.BUCKET.delete(keys);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!(await matchesImport(ctx.env.DB, p))) throw new ForbiddenError();
  await ctx.env.BUCKET.delete(p.objectKey);
}
