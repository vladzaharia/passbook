import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type {
  CloneTemplateSchema,
  ForkTemplateRequest,
  UseBlueprintCheckRequest,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority } from './access.ts';
import { putVersionAsset } from './asset-storage.ts';
import { imagesFromBinding } from './images-binding.ts';
import { audit, resolveCurrentTemplate } from './mutations.ts';
import { cloneSourceOptions, commitClonedVersion, prepareClone } from './mutations-clone.ts';
import type { ImageTools } from './package/images.ts';
import { commitVersion } from './persist.ts';
import { createTemplateRegistry, r2Key } from './registry.ts';
import { getVersion, latestVersionName } from './repo.ts';
import type { ForkLineage } from './repo-forks.ts';
import { hasCloneAuthority, hasTemplateSource } from './repo-source.ts';
import { getVersionHashes } from './repo-version-hashes.ts';
import { detail, loadTemplate } from './service.ts';
import { checkVersion, refusedResponse, type VersionResponse } from './version-check.ts';

type Draft = NonNullable<ForkTemplateRequest['version']>;
type Target = Awaited<ReturnType<typeof prepareClone>>;

export function notBlueprint(): ValidationError {
  return new ValidationError(
    'Only blueprints can be used. Duplicate a template instead.',
    [],
    'TEMPLATE_NOT_BLUEPRINT',
  );
}

/** The draft as a template's: the name it gets, and never a blueprint flag or an org key. */
export function asTemplate(draft: Draft, name: string): Draft {
  const { blueprint: _flag, org: _org, ...manifest } = draft.manifest;
  return { ...draft, manifest: { ...manifest, name } };
}

/** The target of a fork: a copy needs an author in the org; "Use blueprint" also needs an offered blueprint. */
export async function prepareFork(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: ForkTemplateRequest,
  blueprintOnly: boolean,
): Promise<Target> {
  const target = await prepareClone(ctx, auth, id, { orgId: body.orgId, name: body.name });
  if (!blueprintOnly) return target;
  if (!target.source.blueprint) throw notBlueprint();
  if (target.source.status !== 'active')
    throw new ConflictError(
      'This blueprint is no longer offered. Pick another.',
      'TEMPLATE_BLUEPRINT_INACTIVE',
    );
  return target;
}

/** The designer's live check of a draft made from a blueprint, as the org's template. Saves nothing. */
export async function checkBlueprintDraft(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: UseBlueprintCheckRequest,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
): Promise<VersionResponse> {
  const { source, org, name } = await prepareFork(ctx, auth, id, body, true);
  const checked = await checkVersion(ctx, source, org.id, asTemplate(body.version, name), images, {
    dryRun: true,
    carry: false,
  });
  if ('refused' in checked) return refusedResponse(true, checked.refused);
  return { ...checked.base, saved: false, created: true, displayOnly: false, template: null };
}

/** The source version a fork starts from, and the lineage that records it. */
async function lineageOf(
  ctx: ServiceContext,
  source: { id: string },
  baseVersion: string | null,
): Promise<ForkLineage> {
  const bases = [];
  if (baseVersion) {
    const hashes = await getVersionHashes(ctx.env.DB, source.id, baseVersion);
    bases.push({
      upstreamVersion: baseVersion,
      contentHash: hashes?.contentHash ?? null,
      via: 'fork' as const,
      parentVersion: null,
    });
  }
  return { upstreamId: source.id, create: true, bases };
}

const sourceChanged = () =>
  new ConflictError('The source template changed. Retry the copy.', 'TEMPLATE_VERSION_CONFLICT');

async function forkExact(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: ForkTemplateRequest,
  clone: Target,
) {
  const { source, sourceAuthority, authority, org, plan } = clone;
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await resolveCurrentTemplate(ctx, registry, source);
  if (body.baseVersion && body.baseVersion !== template.version) throw sourceChanged();
  const sourceVersion = await getVersion(ctx.env.DB, id, template.version);
  const sourceFence = {
    id,
    orgId: source.orgId,
    version: template.version,
    ...(sourceAuthority ? { authority: sourceAuthority } : {}),
  };
  const assertSource = async () => {
    const allowed = await hasTemplateSource(ctx.env.DB, sourceFence, ctx.clock.now());
    if (allowed) return;
    const current = await loadTemplate(ctx, auth, id, body.orgId, cloneSourceOptions);
    if (current.orgId !== source.orgId || !(await getVersion(ctx.env.DB, id, template.version)))
      throw sourceChanged();
    throw new ForbiddenError();
  };
  const assertCloneAuthority = async () => {
    const allowed = await hasCloneAuthority(
      ctx.env.DB,
      authority,
      org.id,
      sourceFence,
      ctx.clock.now(),
    );
    if (allowed) return;
    await assertSource();
    await assertTemplateAuthority(ctx, authority);
    throw new ForbiddenError();
  };
  await commitClonedVersion(ctx, clone, {
    registry,
    template,
    sourceVersion,
    sourceFence,
    lineage: await lineageOf(ctx, source, sourceVersion ? template.version : null),
    assertSource,
    assertCloneAuthority,
  });
  const action = source.blueprint ? 'template.use_blueprint' : 'template.clone';
  await audit(ctx, auth, { id: plan.templateId, orgId: org.id }, action, {
    sourceId: id,
    sourceVersion: template.version,
  });
  return detail(ctx, auth, plan.templateId);
}

async function forkDraft(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: ForkTemplateRequest & { version: Draft },
  target: Target,
  images: ImageTools,
) {
  const { source, sourceAuthority, authority, org, name, slug, plan, createdBy } = target;
  const baseVersion =
    body.baseVersion ?? source.activeVersion ?? (await latestVersionName(ctx.env.DB, id)) ?? null;
  if (baseVersion && !(await getVersion(ctx.env.DB, id, baseVersion))) throw sourceChanged();
  const checked = await checkVersion(ctx, source, org.id, asTemplate(body.version, name), images, {
    dryRun: false,
    carry: false,
  });
  if ('refused' in checked) return refusedResponse(false, checked.refused);
  const { analysis, report } = checked;
  const assets = [];
  for (const a of analysis.assets) {
    // Every file is copied under the new template: it must outlive the source's versions.
    const key = r2Key(org.id, plan.templateId, analysis.version, a.name);
    const bytes = analysis.files.get(a.name);
    if (!bytes) throw new Error(`Missing file ${a.name}`);
    await assertTemplateAuthority(ctx, authority);
    await putVersionAsset(ctx, key, bytes);
    assets.push({ ...a, source: { kind: 'r2' as const, key } });
  }
  await commitVersion(ctx, {
    plan,
    orgId: org.id,
    slug,
    name: analysis.manifest.name,
    description: analysis.manifest.description ?? null,
    createdBy,
    authorities: [authority],
    ...(baseVersion
      ? {
          source: {
            id,
            orgId: source.orgId,
            version: baseVersion,
            ...(sourceAuthority ? { authority: sourceAuthority } : {}),
          },
        }
      : {}),
    ...(source.blueprint ? { sourceBlueprint: id } : {}),
    lineage: await lineageOf(ctx, source, baseVersion),
    body: {
      version: analysis.version,
      manifest: analysis.manifest as TemplateManifest,
      passJson: analysis.passJson,
      assets,
      report,
      styles: analysis.styles,
    },
  });
  await audit(
    ctx,
    auth,
    { id: plan.templateId, orgId: org.id },
    source.blueprint ? 'template.use_blueprint' : 'template.clone',
    { sourceId: id, version: analysis.version, draft: true },
  );
  return detail(ctx, auth, plan.templateId);
}

/**
 * Makes a tracked copy of a template in an org: "Use blueprint" and Duplicate. Without `version` the
 * copy is exact; the designer's draft is validated like any saved version first. The fork row and the
 * source version it starts from commit with the first version. Releases follow the template's usual
 * review: the new version is a candidate, never active by itself.
 */
export async function forkTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: ForkTemplateRequest,
  options: { blueprintOnly?: boolean; images?: ImageTools } = {},
) {
  const target = await prepareFork(ctx, auth, id, body, options.blueprintOnly === true);
  if (!body.version) return forkExact(ctx, auth, id, body, target);
  return forkDraft(
    ctx,
    auth,
    id,
    { ...body, version: body.version },
    target,
    options.images ?? imagesFromBinding(ctx.env.IMAGES, ctx.log),
  );
}

/** Duplicate: an exact copy of any template the caller can read. */
export function cloneTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof CloneTemplateSchema>,
) {
  return forkTemplate(ctx, auth, id, body);
}
