import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audit } from './mutations.ts';
import { clearTemplateCache } from './registry.ts';
import { countPassesOutsideOrg, findTemplateBySlug, getOrgName, setTemplateOrg } from './repo.ts';
import { detail, loadTemplate } from './service.ts';

/** Org is D1 metadata, so this works for baked templates too. Unassigning is always allowed. */
export async function assignOrg(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId: string | null,
) {
  const row = await loadTemplate(ctx, auth, id);
  if (orgId !== row.orgId) {
    if (orgId) {
      if (!(await getOrgName(ctx.env.DB, orgId)))
        throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
      if ((await countPassesOutsideOrg(ctx.env.DB, id, orgId)) > 0)
        throw new ConflictError(
          'Passes of another organization use this template. Reissue or delete them first.',
          'TEMPLATE_USED_BY_OTHER_ORG',
        );
    }
    const clash = await findTemplateBySlug(ctx.env.DB, orgId, row.slug);
    if (clash && clash.id !== id)
      throw new ConflictError(
        'That organization has a template with this name. Rename one first.',
        'TEMPLATE_EXISTS',
      );
    await setTemplateOrg(ctx.env.DB, id, orgId, ctx.clock.now());
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, { id, orgId: orgId ?? row.orgId }, 'template.assign_org', {
      from: row.orgId,
      to: orgId,
    });
  }
  return detail(ctx, auth, id);
}
