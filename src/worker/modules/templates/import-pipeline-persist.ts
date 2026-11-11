import type { AssetEntry } from '../../../passkit/types.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority } from './access.ts';
import { putVersionAsset } from './asset-storage.ts';
import type { ImportParams } from './import-pipeline.ts';
import {
  assertStageAuthority,
  getBytes,
  getJson,
  type Saved,
  stage,
} from './import-pipeline-staging.ts';
import { commitVersion, planTemplate, slugify } from './persist.ts';
import { r2Key } from './registry.ts';
import { completeImport, getTemplate, matchesImport } from './repo.ts';

export async function persistAuthorizedStage(
  ctx: ServiceContext,
  p: ImportParams,
): Promise<{ templateId: string; version: string }> {
  const authority = await assertStageAuthority(ctx, p);
  const createdBy = authority.userId;
  const saved = await getJson<Saved>(ctx, `${stage(p)}analysis.json`);
  const a = saved.analysis;
  const name = a.manifest.name;
  const slug = slugify(name);
  const plan = await planTemplate(ctx, p.orgId, slug);
  if (plan.existing && plan.existing.status !== 'active') {
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');
  }
  const assertWritable = async () => {
    if (!plan.isNew) {
      const current = await getTemplate(ctx.env.DB, plan.templateId);
      if (!current || current.orgId !== p.orgId || current.status !== 'active') {
        throw new ConflictError(
          'The template changed. Retry the save.',
          'TEMPLATE_VERSION_CONFLICT',
        );
      }
    }
    if (!(await matchesImport(ctx.env.DB, p))) throw new ForbiddenError();
    await assertTemplateAuthority(ctx, authority, true);
  };
  const assets: AssetEntry[] = a.assets.map((x) => ({
    ...x,
    source: { kind: 'r2', key: r2Key(p.orgId, plan.templateId, a.version, x.name) },
  }));
  for (const asset of assets) {
    if (asset.source.kind !== 'r2') continue;
    const bytes = await getBytes(ctx, `${stage(p)}b/${asset.name}`);
    await assertWritable();
    await putVersionAsset(ctx, asset.source.key, bytes);
  }
  if (a.hasTooling) {
    const tooling = await getBytes(ctx, `${stage(p)}tooling.json`);
    await assertWritable();
    await putVersionAsset(ctx, r2Key(p.orgId, plan.templateId, a.version, 'tooling.json'), tooling);
  }
  const committed = await commitVersion(ctx, {
    plan,
    orgId: p.orgId,
    slug,
    name,
    description: a.manifest.description ?? null,
    createdBy,
    guardActive: true,
    deferred: true,
    authorities: [authority],
    importSource: { uploadId: p.uploadId, orgId: p.orgId, objectKey: p.objectKey, createdBy },
    body: {
      version: a.version,
      manifest: a.manifest,
      passJson: a.passJson,
      assets,
      report: a.report,
      styles: a.styles,
    },
  });
  if (
    !(await completeImport(
      ctx.env.DB,
      p,
      authority,
      committed.templateId,
      a.version,
      a.report,
      ctx.clock.now(),
    ))
  ) {
    throw new ForbiddenError();
  }
  ctx.log.info('templates.imported', {
    orgId: p.orgId,
    templateId: committed.templateId,
    created: committed.versionCreated,
  });
  return { templateId: committed.templateId, version: a.version };
}
