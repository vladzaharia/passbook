import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../../../passkit/types.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateAuthority } from './access.ts';
import { buildKey } from './package/hash.ts';
import { findTemplateBySlug, type TemplateRow, versionContentMatches } from './repo.ts';
import { versionIsRetired, writeVersion } from './repo-persist.ts';

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : 'template';
}

export interface TemplatePlan {
  templateId: string;
  isNew: boolean;
  existing: TemplateRow | null;
}

/** Re-uploading a slug adds a version to the same template. Baked slugs are off limits. */
export async function planTemplate(
  ctx: ServiceContext,
  orgId: string | null,
  slug: string,
): Promise<TemplatePlan> {
  const existing = await findTemplateBySlug(ctx.env.DB, orgId, slug);
  if (existing?.origin === 'baked')
    throw new ForbiddenError('A baked template uses this name. Pick another.', 'TEMPLATE_BAKED');
  return { templateId: existing?.id ?? ctx.ids.id(), isNew: !existing, existing };
}

export interface VersionBody {
  version: string;
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  report: ValidationReport;
  styles: PassStyle[];
}

export interface CommitArgs {
  plan: TemplatePlan;
  orgId: string | null;
  slug: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  body: VersionBody;
  /** Guard candidate insertion against concurrent organization or status changes. */
  guardActive?: boolean;
  /** A key already calculated for the same body, for callers which also need to compare it. */
  buildKey?: string;
  /** Every commit is fenced by the request's captured write authorities. */
  authorities: TemplateAuthority[];
  /** Source lineage and read authority for cloning a particular version. */
  source?: {
    id: string;
    orgId: string | null;
    version: string;
    authority?: TemplateAuthority;
  };
  /** Queued work (an import): the authority needs no live session (owner answer 2). */
  deferred?: boolean;
  /** Upload record whose immutable identity must still match this import. */
  importSource?: { uploadId: string; orgId: string | null; objectKey: string; createdBy: string };
}

/** Writes a candidate version without changing the active version. */
export async function commitVersion(
  ctx: ServiceContext,
  args: CommitArgs,
): Promise<{ templateId: string; versionCreated: boolean }> {
  if (
    !args.authorities?.length ||
    args.authorities.some(
      (authority) => authority.kind === 'session' && authority.capability !== 'templates:author',
    )
  ) {
    throw new ForbiddenError();
  }
  const importSource = args.importSource;
  if (
    importSource &&
    (args.orgId !== importSource.orgId ||
      args.createdBy !== importSource.createdBy ||
      args.authorities.some((authority) => authority.userId !== importSource.createdBy))
  ) {
    throw new ForbiddenError();
  }

  const { plan, body } = args;
  if (!plan.isNew && args.guardActive && !plan.existing)
    throw new ConflictError('The template changed. Retry the save.', 'TEMPLATE_VERSION_CONFLICT');
  if (plan.isNew && (await versionIsRetired(ctx.env.DB, plan.templateId, body.version)))
    throw new ConflictError('This template version is retired.', 'TEMPLATE_VERSION_CONFLICT');
  const key = args.buildKey ?? (await buildKey(body));
  let written: Awaited<ReturnType<typeof writeVersion>>;
  try {
    written = await writeVersion(ctx, args, key, ctx.clock.now());
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message))
      throw new ConflictError(
        'A template with this name was created meanwhile. Retry.',
        'TEMPLATE_SLUG_CONFLICT',
      );
    throw error;
  }
  const { created: versionCreated, stored } = written;
  if (
    !stored ||
    stored.version === null ||
    (!versionCreated && !versionContentMatches(stored, { ...body, buildKey: key }))
  )
    throw new ConflictError(
      'This template version is retired or already has different content.',
      'TEMPLATE_VERSION_CONFLICT',
    );
  return {
    templateId: plan.templateId,
    versionCreated,
  };
}
