import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority, authorizeTemplateWrite } from './access.ts';
import { audit } from './mutations.ts';
import { clearTemplateCache } from './registry.ts';
import { countPassesOutsideOrg, findTemplateBySlug, getOrgName } from './repo.ts';
import { assignTemplateOrg, hasAssignmentHistory, hasScanReferences } from './repo-assignment.ts';
import { detail, loadTemplate } from './service.ts';

function usedByOtherOrg(): ConflictError {
  return new ConflictError(
    'Passes of another organization use this template. Reissue or delete them first.',
    'TEMPLATE_USED_BY_OTHER_ORG',
  );
}

function releaseRequired(): ConflictError {
  return new ConflictError(
    'A template with release or candidate history cannot change organizations. Clone it instead.',
    'TEMPLATE_RELEASE_REQUIRED',
  );
}

/** Reassigning global or baked metadata also requires a platform administrator. */
export async function assignOrg(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId: string | null,
) {
  const row = await loadTemplate(ctx, auth, id);
  // Only a platform grant sets a template's org, so every move needs a platform administrator.
  const authority = await authorizeTemplateWrite(ctx, auth, null, 'templates:author');
  if (authority.kind !== 'platform') throw new ForbiddenError();
  const before = await detail(ctx, auth, id);
  if (orgId !== row.orgId) {
    if (orgId && !(await getOrgName(ctx.env.DB, orgId)))
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    if (await hasAssignmentHistory(ctx.env.DB, id)) throw releaseRequired();
    if (await hasScanReferences(ctx.env.DB, id))
      throw new ConflictError(
        'Scanning events or setups use this template. Remove it from them first.',
        'TEMPLATE_IN_USE',
      );
    if (row.origin === 'uploaded' && row.activeVersion !== null) throw releaseRequired();
    if (orgId) {
      if ((await countPassesOutsideOrg(ctx.env.DB, id, orgId)) > 0) throw usedByOtherOrg();
    }
    const clash = await findTemplateBySlug(ctx.env.DB, orgId, row.slug);
    if (clash && clash.id !== id)
      throw new ConflictError(
        'That organization has a template with this name. Rename one first.',
        'TEMPLATE_EXISTS',
      );
    const now = ctx.clock.now();
    const updated = await assignTemplateOrg(ctx, id, row, orgId, authority, now);
    if (!updated) {
      const current = await loadTemplate(ctx, auth, id, row.orgId ?? undefined);
      if (current.orgId !== row.orgId)
        throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
      await assertTemplateAuthority(ctx, authority);
      if (await hasAssignmentHistory(ctx.env.DB, id)) throw releaseRequired();
      if (
        row.origin === 'uploaded' &&
        current.origin === 'uploaded' &&
        current.activeVersion !== null
      )
        throw releaseRequired();
      if (orgId && (await countPassesOutsideOrg(ctx.env.DB, id, orgId)) > 0) throw usedByOtherOrg();
      throw new ConflictError('The template changed. Reload and retry.', 'TEMPLATE_CONFLICT');
    }
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, { id, orgId: orgId ?? row.orgId }, 'template.assign_org', {
      from: row.orgId,
      to: orgId,
    });
  }
  try {
    return await detail(ctx, auth, id);
  } catch (error) {
    // An administrator who is not in the destination org cannot read it there: answer with what they just moved.
    if (!(error instanceof NotFoundError) || orgId === row.orgId) throw error;
    const org = orgId ? await getOrgName(ctx.env.DB, orgId) : null;
    return { ...before, orgId, orgName: org?.name ?? null };
  }
}
