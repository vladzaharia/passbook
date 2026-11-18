import type { AuthContext } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import {
  assertTemplateAuthority,
  authorizeTemplateWrite,
  type TemplateAuthority,
} from './access.ts';
import { deletePrefix } from './mutations-assets.ts';
import { persistManifestReplacement } from './mutations-manifest.ts';
import {
  type CompositeTemplateRegistry,
  clearTemplateCache,
  createTemplateRegistry,
  r2Prefix,
} from './registry.ts';
import { hasPasses, latestVersionName, listVersions, type TemplateRow } from './repo.ts';
import { hasForks } from './repo-forks.ts';
import {
  archiveUploadedTemplate,
  deleteUploadedTemplate,
  hasApprovedLiveHead,
  hasTemplateHistory,
  restoreUploadedTemplate,
  softDeleteUploadedTemplate,
} from './repo-mutations.ts';
import { detail, loadTemplate } from './service.ts';
import { assertStampsUnchanged } from './stamps.ts';

function baked(row: TemplateRow): ForbiddenError | null {
  return row.origin === 'baked'
    ? new ForbiddenError('Baked templates cannot be changed. Clone it first.', 'TEMPLATE_BAKED')
    : null;
}

/** Preserve the by-ID 404 mask if membership disappears during authorization. */
export async function authorizeTemplateMutation(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: TemplateRow,
  capability: 'templates:author' | 'templates:publish',
): Promise<TemplateAuthority> {
  try {
    return await authorizeTemplateWrite(ctx, auth, row.orgId, capability);
  } catch (error) {
    if (error instanceof ForbiddenError) await loadTemplate(ctx, auth, row.id);
    throw error;
  }
}

export function audit(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: { id: string; orgId: string | null },
  action: string,
  detailData: Record<string, unknown> = {},
) {
  const actor = actorOf(auth);
  return recordAudit(ctx, {
    orgId: row.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType: 'template',
    targetId: row.id,
    detail: detailData,
  });
}

/** Resolve the active version, or a draft's latest candidate, for authorized editing or export. */
export async function resolveCurrentTemplate(
  ctx: ServiceContext,
  registry: CompositeTemplateRegistry,
  row: TemplateRow,
) {
  const version = row.activeVersion ?? (await latestVersionName(ctx.env.DB, row.id));
  if (!version) throw new NotFoundError('Template has no version.', 'TEMPLATE_NOT_FOUND');
  return registry.resolve(row.id, version);
}

export async function replaceManifest(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  input: Record<string, unknown>,
) {
  const row = await loadTemplate(ctx, auth, id);
  const denied = baked(row);
  if (denied) throw denied;
  const authority = await authorizeTemplateMutation(ctx, auth, row, 'templates:author');
  if (row.status !== 'active')
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const current = await resolveCurrentTemplate(ctx, registry, row);
  assertStampsUnchanged(current.manifest, input);
  const version = await persistManifestReplacement(ctx, {
    id,
    auth,
    row,
    authority,
    registry,
    current,
    input,
  });
  if (version !== null) {
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, row, 'template.manifest', { version, previous: current.version });
  }
  return detail(ctx, auth, id);
}

/** Assets stay under the org they were uploaded for, so reassigning must not change where to delete. */
export async function storageOrg(ctx: ServiceContext, row: TemplateRow): Promise<string | null> {
  for (const v of await listVersions(ctx.env.DB, row.id))
    for (const a of v.assets) {
      const m = a.source.kind === 'r2' ? a.source.key.match(/^templates\/([^/]+)\//) : null;
      if (m) return m[1] === 'platform' ? null : (m[1] ?? null);
    }
  return row.orgId;
}

async function templateChanged(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: TemplateRow,
  authority: TemplateAuthority,
): Promise<never> {
  // Reload first so an inaccessible or deleted row remains masked as a 404.
  await loadTemplate(ctx, auth, row.id);
  await assertTemplateAuthority(ctx, authority);
  throw new ConflictError('The template changed. Reload and retry.', 'TEMPLATE_VERSION_CONFLICT');
}

/** Archive only the row whose organization and status were authorized. */
export async function archiveTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: TemplateRow,
  authority: TemplateAuthority,
): Promise<void> {
  if (authority.kind === 'session' && authority.capability !== 'templates:publish')
    throw new ForbiddenError();
  const now = ctx.clock.now();
  const archived = await archiveUploadedTemplate(ctx, row, authority, now);
  if (!archived) return templateChanged(ctx, auth, row, authority);
  clearTemplateCache(ctx.env, row.id);
  await audit(ctx, auth, row, 'template.archive');
}

/** Restore an archived template unless an approved Live head exists; then a rollback restores it. */
export async function restoreTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: TemplateRow,
  authority: TemplateAuthority,
): Promise<void> {
  if (authority.kind === 'session' && authority.capability !== 'templates:publish')
    throw new ForbiddenError();
  if (await hasApprovedLiveHead(ctx.env.DB, row.id))
    throw new ConflictError(
      'Restore this template by rolling back to a release in Live.',
      'TEMPLATE_RELEASE_REQUIRED',
    );
  const restored = await restoreUploadedTemplate(ctx, row, authority, ctx.clock.now());
  if (!restored) return templateChanged(ctx, auth, row, authority);
  clearTemplateCache(ctx.env, row.id);
  await audit(ctx, auth, row, 'template.restore');
}

/** Preserve immutable history while deleting unused templates and archiving those with passes. */
export async function removeTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<'deleted' | 'archived'> {
  const row = await loadTemplate(ctx, auth, id);
  const denied = baked(row);
  if (denied) throw denied;
  const authority = await authorizeTemplateMutation(ctx, auth, row, 'templates:publish');
  const archive = async () => {
    await archiveTemplate(ctx, auth, row, authority);
    return 'archived' as const;
  };
  const finishDelete = async () => {
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, row, 'template.delete', { slug: row.slug });
    return 'deleted' as const;
  };
  const softDelete = async () => {
    const now = ctx.clock.now();
    const deleted = await softDeleteUploadedTemplate(ctx, row, id, authority, now);
    if (!deleted) {
      if (await hasPasses(ctx.env.DB, id)) return archive();
      return templateChanged(ctx, auth, row, authority);
    }
    return finishDelete();
  };
  if (await hasPasses(ctx.env.DB, id)) return archive();
  // Lineage stays readable: a template that others were copied from is archived, never deleted.
  if (await hasForks(ctx.env.DB, id)) return archive();
  if (await hasTemplateHistory(ctx.env.DB, id)) return softDelete();
  const prefix = r2Prefix(await storageOrg(ctx, row), id);
  try {
    const deleted = await deleteUploadedTemplate(ctx, row, id, authority);
    if (!deleted) {
      if (await hasPasses(ctx.env.DB, id)) return archive();
      if (await hasTemplateHistory(ctx.env.DB, id)) return softDelete();
      return templateChanged(ctx, auth, row, authority);
    }
  } catch (error) {
    // A pass was created after the count; the foreign key keeps the rows.
    if (classifyD1Error(error)?.kind === 'foreign_key') return archive();
    throw error;
  }
  const result = await finishDelete();
  await deletePrefix(ctx, prefix, authority);
  return result;
}
