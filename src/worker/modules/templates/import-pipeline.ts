import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import type { AssetEntry, ValidationIssue, ValidationReport } from '../../../passkit/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dryRunReport } from './dry-run-report.ts';
import { imagesFromBinding } from './images-binding.ts';
import { type Analysis, analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { extractArchive, ImportError } from './package/unzip.ts';
import { commitVersion, planTemplate, slugify } from './persist.ts';
import { r2Key } from './registry.ts';
import { getImport, setWorkflowRun, updateImport } from './repo.ts';

export interface ImportParams {
  uploadId: string;
  orgId: string | null;
  objectKey: string;
  createdBy: string | null;
}

export interface StageResult {
  ok: boolean;
}

const behaviors = createBehaviorRegistry([...behaviorPlugins]);
const stage = (p: ImportParams) => `uploads/${p.uploadId}/`;

interface Saved {
  name: string | null;
  analysis: Omit<Analysis, 'files' | 'tooling'> & { hasTooling: boolean };
}

async function putJson(ctx: ServiceContext, key: string, value: unknown): Promise<void> {
  await ctx.env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function getJson<T>(ctx: ServiceContext, key: string): Promise<T> {
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw new Error(`Missing staged object ${key}`);
  return (await object.json()) as T;
}

async function getBytes(ctx: ServiceContext, key: string): Promise<Uint8Array> {
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw new Error(`Missing staged object ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

/** Records a failed import. The workflow ends normally: invalid input is not retryable. */
export async function failImport(
  ctx: ServiceContext,
  p: ImportParams,
  issues: ValidationIssue[],
  code: string,
): Promise<void> {
  const report: ValidationReport = { ok: false, issues };
  const now = ctx.clock.now();
  await updateImport(ctx.env.DB, p.uploadId, { step: 'failed', report, error: code }, now);
  await setWorkflowRun(ctx.env.DB, p.uploadId, 'errored', now, { errorCode: code });
  ctx.log.info('templates.import_rejected', { orgId: p.orgId, code });
}

export async function startImport(ctx: ServiceContext, p: ImportParams): Promise<void> {
  const now = ctx.clock.now();
  await setWorkflowRun(ctx.env.DB, p.uploadId, 'running', now);
  await updateImport(ctx.env.DB, p.uploadId, { step: 'extract' }, now);
}

export async function extractStage(ctx: ServiceContext, p: ImportParams): Promise<StageResult> {
  const zip = await ctx.env.BUCKET.get(p.objectKey);
  if (!zip) {
    await failImport(
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
    for (const [path, bytes] of files) await ctx.env.BUCKET.put(`${stage(p)}x/${path}`, bytes);
    await putJson(ctx, `${stage(p)}files.json`, [...files.keys()]);
    await updateImport(ctx.env.DB, p.uploadId, { step: 'analyze' }, ctx.clock.now());
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    await failImport(
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
    await failImport(ctx, p, result.report.issues, 'IMPORT_INVALID');
    return { ok: false };
  }
  for (const [path, bytes] of result.files) await ctx.env.BUCKET.put(`${stage(p)}b/${path}`, bytes);
  const { files: _files, tooling, ...rest } = result;
  if (tooling) await ctx.env.BUCKET.put(`${stage(p)}tooling.json`, tooling);
  const saved: Saved = {
    name: record?.name ?? null,
    analysis: { ...rest, hasTooling: tooling !== null },
  };
  await putJson(ctx, `${stage(p)}analysis.json`, saved);
  await updateImport(ctx.env.DB, p.uploadId, { step: 'dry-run' }, ctx.clock.now());
  return { ok: true };
}

export async function dryRunStage(ctx: ServiceContext, p: ImportParams): Promise<StageResult> {
  const saved = await getJson<Saved>(ctx, `${stage(p)}analysis.json`);
  const a = saved.analysis;
  const report = await dryRunReport(ctx, p.orgId, { ...a, report: a.report }, (name) =>
    getBytes(ctx, `${stage(p)}b/${name}`),
  );
  if (!report.ok) {
    await failImport(ctx, p, report.issues, 'IMPORT_INVALID');
    return { ok: false };
  }
  await putJson(ctx, `${stage(p)}analysis.json`, { ...saved, analysis: { ...a, report } });
  await updateImport(ctx.env.DB, p.uploadId, { step: 'persist' }, ctx.clock.now());
  return { ok: true };
}

export async function persistStage(
  ctx: ServiceContext,
  p: ImportParams,
): Promise<{ templateId: string; version: string } | null> {
  const saved = await getJson<Saved>(ctx, `${stage(p)}analysis.json`);
  const a = saved.analysis;
  const name = a.manifest.name;
  const slug = slugify(name);
  let plan: Awaited<ReturnType<typeof planTemplate>>;
  try {
    plan = await planTemplate(ctx, p.orgId, slug);
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    await failImport(
      ctx,
      p,
      [{ severity: 'error', code: error.code, message: error.message }],
      error.code,
    );
    return null;
  }
  const assets: AssetEntry[] = a.assets.map((x) => ({
    ...x,
    source: { kind: 'r2', key: r2Key(p.orgId, plan.templateId, a.version, x.name) },
  }));
  for (const asset of assets) {
    if (asset.source.kind !== 'r2') continue;
    await ctx.env.BUCKET.put(asset.source.key, await getBytes(ctx, `${stage(p)}b/${asset.name}`));
  }
  if (a.hasTooling)
    await ctx.env.BUCKET.put(
      r2Key(p.orgId, plan.templateId, a.version, 'tooling.json'),
      await getBytes(ctx, `${stage(p)}tooling.json`),
    );
  const committed = await commitVersion(ctx, {
    plan,
    orgId: p.orgId,
    slug,
    name,
    description: a.manifest.description ?? null,
    createdBy: p.createdBy,
    body: {
      version: a.version,
      manifest: a.manifest,
      passJson: a.passJson,
      assets,
      report: a.report,
      styles: a.styles,
    },
  });
  const now = ctx.clock.now();
  await updateImport(
    ctx.env.DB,
    p.uploadId,
    { step: 'done', templateId: committed.templateId, version: a.version, report: a.report },
    now,
  );
  await setWorkflowRun(ctx.env.DB, p.uploadId, 'complete', now, { targetId: committed.templateId });
  ctx.log.info('templates.imported', {
    orgId: p.orgId,
    templateId: committed.templateId,
    created: committed.versionCreated,
  });
  return { templateId: committed.templateId, version: a.version };
}

/** Removes staged objects (the upload and everything under uploads/<id>/). */
export async function cleanupStage(ctx: ServiceContext, p: ImportParams): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({ prefix: stage(p), cursor, limit: 500 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await ctx.env.BUCKET.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await ctx.env.BUCKET.delete(p.objectKey);
}
