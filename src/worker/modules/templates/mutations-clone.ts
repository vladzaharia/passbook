import type { z } from 'zod';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AssetEntry, TemplateManifest } from '../../../passkit/types.ts';
import type { CloneTemplateSchema } from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { authorizeTemplateWrite, type TemplateAuthority } from './access.ts';
import { putVersionAsset } from './asset-storage.ts';
import { readAll } from './mutations-assets.ts';
import { contentVersion } from './package/hash.ts';
import { stylesOf } from './package/slots.ts';
import {
  type CommitArgs,
  commitVersion,
  planTemplate,
  slugify,
  type TemplatePlan,
} from './persist.ts';
import { type CompositeTemplateRegistry, r2Key } from './registry.ts';
import { getOrgName, type TemplateRow, type VersionRow } from './repo.ts';
import { loadTemplate } from './service.ts';

export const cloneSourceOptions = { useOrgForGlobalOnly: true } as const;

interface CloneTarget {
  source: TemplateRow;
  authority: TemplateAuthority;
  sourceAuthority: Extract<TemplateAuthority, { kind: 'session' }> | undefined;
  org: { id: string; name: string; slug: string };
  name: string;
  slug: string;
  plan: TemplatePlan;
  createdBy: string;
}

export async function prepareClone(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof CloneTemplateSchema>,
): Promise<CloneTarget> {
  const source = await loadTemplate(ctx, auth, id, body.orgId, cloneSourceOptions);
  if (auth?.kind !== 'session') throw new ForbiddenError();
  const authority = await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:author');
  let sourceAuthority: Extract<TemplateAuthority, { kind: 'session' }> | undefined;
  if (source.orgId !== null) {
    try {
      const readAuthority = await tenantAuthorityOf(ctx, auth, source.orgId, 'templates:read');
      if (readAuthority.kind !== 'session') throw new ForbiddenError();
      sourceAuthority = readAuthority;
    } catch (error) {
      if (error instanceof ForbiddenError)
        await loadTemplate(ctx, auth, id, body.orgId, cloneSourceOptions);
      throw error;
    }
  }
  const org = await getOrgName(ctx.env.DB, body.orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const name = body.name ?? `${source.name} copy`;
  const slug = slugify(name);
  const plan = await planTemplate(ctx, org.id, slug);
  if (!plan.isNew)
    throw new ConflictError(
      'A template with this name exists. Pick another name.',
      'TEMPLATE_EXISTS',
    );
  return { source, authority, sourceAuthority, org, name, slug, plan, createdBy: auth.userId };
}

type CloneVersionArgs = {
  registry: CompositeTemplateRegistry;
  template: ResolvedTemplate;
  sourceVersion: VersionRow | null;
  sourceFence: NonNullable<CommitArgs['source']>;
  assertSource: () => Promise<void>;
  assertCloneAuthority: () => Promise<void>;
};

/** Copy a version's immutable assets under the destination and commit its candidate. */
export async function commitClonedVersion(
  ctx: ServiceContext,
  clone: CloneTarget,
  {
    registry,
    template,
    sourceVersion,
    sourceFence,
    assertSource,
    assertCloneAuthority,
  }: CloneVersionArgs,
) {
  const { authority, org, plan, slug, name, createdBy } = clone;
  const manifest = { ...template.manifest, name } as TemplateManifest & { org?: unknown };
  delete manifest.org;
  const sha = new Map(template.assets.map((a) => [a.name, a.sha1]));
  const version = await contentVersion({
    passJson: template.passJson,
    manifest,
    assets: template.assets.map((a) => ({ name: a.name, sha1: sha.get(a.name) ?? '' })),
  });
  const assets: AssetEntry[] = [];
  for (const asset of template.assets) {
    const key = r2Key(org.id, plan.templateId, version, asset.name);
    await assertCloneAuthority();
    const bytes = await readAll(await registry.openAsset(template, asset.name));
    await assertCloneAuthority();
    await putVersionAsset(ctx, key, bytes);
    assets.push({ ...asset, source: { kind: 'r2', key } });
  }
  await assertSource();
  try {
    await commitVersion(ctx, {
      plan,
      orgId: org.id,
      slug,
      name,
      description: manifest.description ?? null,
      createdBy,
      authorities: [authority],
      source: sourceFence,
      body: {
        version,
        manifest,
        passJson: template.passJson,
        assets,
        report: sourceVersion?.report ?? { ok: true, issues: [] },
        styles: stylesOf(template.passJson),
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) await assertSource();
    throw error;
  }
}
