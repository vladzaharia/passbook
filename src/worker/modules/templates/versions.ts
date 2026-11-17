import type { z } from 'zod';
import type {
  SaveVersionResponseSchema,
  SaveVersionSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority, authorizeTemplateWrite } from './access.ts';
import { putVersionAsset } from './asset-storage.ts';
import { imagesFromBinding } from './images-binding.ts';
import { audit, storageOrg } from './mutations.ts';
import { buildKey } from './package/hash.ts';
import type { ImageTools } from './package/images.ts';
import { commitVersion } from './persist.ts';
import { clearTemplateCache, r2Key } from './registry.ts';
import { getTemplate, getVersion } from './repo.ts';
import { detail, loadTemplate } from './service.ts';
import { checkVersion, refusedResponse } from './version-check.ts';

type Body = z.infer<typeof SaveVersionSchema>;
type Response = z.infer<typeof SaveVersionResponseSchema>;

/**
 * Validates a version written from JSON (the designer) with the upload pipeline's own steps:
 * package analysis with image checks, the dry-run build, then the same commit. With `dryRun` it
 * stores nothing and returns the report and the built pass for the live preview.
 */
export async function saveVersion(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: Body,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
): Promise<Response> {
  const row = await loadTemplate(ctx, auth, id);
  const author = await authorizeTemplateWrite(ctx, auth, row.orgId, 'templates:author');
  if (row.origin === 'baked')
    throw new ForbiddenError(
      'Built-in templates cannot be changed. Duplicate it first.',
      'TEMPLATE_BAKED',
    );
  if (row.status !== 'active')
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');

  const checked = await checkVersion(ctx, row, row.orgId, body, images, {
    dryRun: body.dryRun === true,
  });
  if ('refused' in checked) return refusedResponse(body.dryRun, checked.refused);
  const { analysis, report, carried, base } = checked;
  const key = await buildKey(analysis);
  const referenceVersion = row.activeVersion;
  const [existing, active] = await Promise.all([
    getVersion(ctx.env.DB, id, analysis.version),
    referenceVersion ? getVersion(ctx.env.DB, id, referenceVersion) : Promise.resolve(null),
  ]);
  const candidateKey = existing ? existing.buildKey : key;
  const displayOnly =
    candidateKey !== null && active?.buildKey != null && candidateKey === active.buildKey;
  if (body.dryRun)
    return {
      ...base,
      saved: false,
      created: !existing,
      displayOnly,
      template: null,
    };

  const owner = await storageOrg(ctx, row);
  const assets = [];
  for (const a of analysis.assets) {
    const keep = carried.get(a.name);
    if (keep && keep.sha1 === a.sha1) {
      assets.push({ ...a, source: keep.source });
      continue;
    }
    const current = await getTemplate(ctx.env.DB, id);
    if (!current || current.orgId !== row.orgId || current.status !== 'active')
      throw new ConflictError('The template changed. Retry the save.', 'TEMPLATE_VERSION_CONFLICT');
    await assertTemplateAuthority(ctx, author);
    const key = r2Key(owner, id, analysis.version, a.name);
    const bytes = analysis.files.get(a.name);
    if (!bytes) throw new Error(`Missing file ${a.name}`);
    await putVersionAsset(ctx, key, bytes);
    assets.push({ ...a, source: { kind: 'r2' as const, key } });
  }
  const committed = await commitVersion(ctx, {
    plan: { templateId: id, isNew: false, existing: row },
    orgId: row.orgId,
    slug: row.slug,
    name: analysis.manifest.name,
    description: analysis.manifest.description ?? null,
    createdBy: auth?.kind === 'session' ? auth.userId : null,
    guardActive: true,
    buildKey: key,
    authorities: [author],
    body: {
      version: analysis.version,
      manifest: analysis.manifest,
      passJson: analysis.passJson,
      assets,
      report,
      styles: analysis.styles,
    },
  }).catch(async (error: unknown) => {
    if (error instanceof ForbiddenError) await loadTemplate(ctx, auth, id, row.orgId ?? undefined);
    throw error;
  });
  const current = await getTemplate(ctx.env.DB, id);
  if (!current || current.orgId !== row.orgId || current.status !== 'active')
    throw new ConflictError('The template changed. Retry the save.', 'TEMPLATE_VERSION_CONFLICT');
  clearTemplateCache(ctx.env, id);
  const persisted = committed.versionCreated
    ? null
    : await getVersion(ctx.env.DB, id, analysis.version);
  if (!committed.versionCreated && !persisted)
    throw new ConflictError('The template changed. Retry the save.', 'TEMPLATE_VERSION_CONFLICT');
  const actualKey = committed.versionCreated ? key : (persisted?.buildKey ?? null);
  const comparisonActive =
    current.activeVersion === referenceVersion
      ? active
      : current.activeVersion
        ? await getVersion(ctx.env.DB, id, current.activeVersion)
        : null;
  const actualDisplayOnly =
    actualKey !== null &&
    comparisonActive?.buildKey != null &&
    actualKey === comparisonActive.buildKey;
  await audit(ctx, auth, row, 'template.version', {
    version: analysis.version,
    displayOnly: actualDisplayOnly,
  });
  return {
    ...base,
    saved: true,
    created: committed.versionCreated,
    displayOnly: actualDisplayOnly,
    template: await detail(ctx, auth, id),
  };
}
