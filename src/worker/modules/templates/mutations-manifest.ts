import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { TemplateManifest, ValidationIssue } from '../../../passkit/types.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateAuthority } from './access.ts';
import { behaviors, dryRun } from './build-check.ts';
import { readAll } from './mutations-assets.ts';
import { contentVersion } from './package/hash.ts';
import { validateManifest } from './package/manifest.ts';
import { commitVersion } from './persist.ts';
import { getOrgName, type TemplateRow } from './repo.ts';
import { loadTemplate } from './service.ts';

type ManifestReplacement = {
  id: string;
  auth: AuthContext | undefined;
  row: TemplateRow;
  authority: TemplateAuthority;
  registry: TemplateRegistry;
  current: ResolvedTemplate;
  input: Record<string, unknown>;
};

/** Validate and commit a changed manifest as a candidate without activating it. */
export async function persistManifestReplacement(
  ctx: ServiceContext,
  { id, auth, row, authority, registry, current, input }: ManifestReplacement,
): Promise<string | null> {
  // A JSON object of unknown shape; validateManifest below is what makes it a manifest.
  const manifest = input as unknown as TemplateManifest;
  const issues: ValidationIssue[] = validateManifest(manifest, current.passJson, {
    uploaded: true,
    behaviors,
  });
  const next = { ...current, manifest };
  if (!issues.some((i) => i.severity === 'error')) {
    const org = row.orgId ? await getOrgName(ctx.env.DB, row.orgId) : null;
    issues.push(
      ...(await dryRun(
        ctx.env,
        next,
        async (name) => readAll(await registry.openAsset(current, name)),
        org?.name ?? row.name,
        new Date(ctx.clock.now()),
        ctx.log,
      )),
    );
  }
  if (issues.some((i) => i.severity === 'error'))
    throw new ValidationError(
      'The manifest is invalid.',
      issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code })),
      'MANIFEST_INVALID',
    );
  const version = await contentVersion({
    passJson: current.passJson,
    manifest,
    assets: current.assets,
  });
  if (version === current.version) return null;
  try {
    await commitVersion(ctx, {
      plan: { templateId: id, isNew: false, existing: row },
      orgId: row.orgId,
      slug: row.slug,
      name: manifest.name,
      description: manifest.description ?? null,
      createdBy: auth?.kind === 'session' ? auth.userId : null,
      authorities: [authority],
      guardActive: true,
      body: {
        version,
        manifest,
        passJson: current.passJson,
        assets: current.assets,
        report: { ok: true, issues },
        styles: current.styles,
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) await loadTemplate(ctx, auth, id);
    throw error;
  }
  return version;
}
