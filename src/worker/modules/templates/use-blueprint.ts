import type { TemplateManifest } from '../../../passkit/types.ts';
import type {
  UseBlueprintCheckRequest,
  UseBlueprintRequest,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority } from './access.ts';
import { putVersionAsset } from './asset-storage.ts';
import { imagesFromBinding } from './images-binding.ts';
import { audit, cloneTemplate } from './mutations.ts';
import { prepareClone } from './mutations-clone.ts';
import type { ImageTools } from './package/images.ts';
import { commitVersion } from './persist.ts';
import { r2Key } from './registry.ts';
import { detail } from './service.ts';
import { checkVersion, refusedResponse, type VersionResponse } from './version-check.ts';

type Draft = NonNullable<UseBlueprintRequest['version']>;

export function notBlueprint(): ValidationError {
  return new ValidationError(
    'Only blueprints can be used. Duplicate a template instead.',
    [],
    'TEMPLATE_NOT_BLUEPRINT',
  );
}

/** The draft as a template's: the name it gets, and never a blueprint flag or an org key. */
function asTemplate(draft: Draft, name: string): Draft {
  const { blueprint: _flag, org: _org, ...manifest } = draft.manifest;
  return { ...draft, manifest: { ...manifest, name } };
}

async function prepare(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: UseBlueprintRequest,
) {
  const target = await prepareClone(ctx, auth, id, { orgId: body.orgId, name: body.name });
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
  const { source, org, name } = await prepare(ctx, auth, id, body);
  const checked = await checkVersion(ctx, source, org.id, asTemplate(body.version, name), images, {
    dryRun: true,
    carry: false,
  });
  if ('refused' in checked) return refusedResponse(true, checked.refused);
  return { ...checked.base, saved: false, created: true, displayOnly: false, template: null };
}

/**
 * Makes a template in an org from a blueprint, as its first version. Without `version` the copy is
 * exact; the designer's draft is validated like any saved version first. Releases follow the
 * template's usual review: the new version is a candidate, never active by itself.
 */
export async function useBlueprint(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: UseBlueprintRequest,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
) {
  const target = await prepare(ctx, auth, id, body);
  if (!body.version) return cloneTemplate(ctx, auth, id, { orgId: body.orgId, name: body.name });

  const { source, authority, org, name, slug, plan, createdBy } = target;
  const checked = await checkVersion(ctx, source, org.id, asTemplate(body.version, name), images, {
    dryRun: false,
    carry: false,
  });
  if ('refused' in checked) return refusedResponse(false, checked.refused);
  const { analysis, report } = checked;
  const assets = [];
  for (const a of analysis.assets) {
    // Every file is copied under the new template: it must outlive the blueprint's versions.
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
    sourceBlueprint: id,
    body: {
      version: analysis.version,
      manifest: analysis.manifest as TemplateManifest,
      passJson: analysis.passJson,
      assets,
      report,
      styles: analysis.styles,
    },
  });
  await audit(ctx, auth, { id: plan.templateId, orgId: org.id }, 'template.use_blueprint', {
    sourceId: id,
    version: analysis.version,
    draft: true,
  });
  return detail(ctx, auth, plan.templateId);
}
