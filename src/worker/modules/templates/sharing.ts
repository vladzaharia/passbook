import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority, authorizeTemplateWrite } from './access.ts';
import { audit } from './mutations.ts';
import { shareTemplate } from './repo-mutations.ts';
import { detail, loadTemplate } from './service.ts';

/**
 * Shares an unassigned upload with every org, or stages it again (platform administrators only).
 * Unsharing does not take back what an org already holds: its candidates and releases stay.
 */
export async function setShared(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  shared: boolean,
) {
  const row = await loadTemplate(ctx, auth, id);
  const authority = await authorizeTemplateWrite(ctx, auth, null, 'templates:author');
  if (authority.kind !== 'platform') throw new ConflictError('Platform only.', 'TEMPLATE_CONFLICT');
  if (row.orgId !== null || row.origin !== 'uploaded' || row.blueprint)
    throw new ConflictError('Only an unassigned upload can be shared.', 'TEMPLATE_NOT_SHAREABLE');
  if (row.shared !== shared) {
    if (!(await shareTemplate(ctx, row, shared, authority, ctx.clock.now()))) {
      await assertTemplateAuthority(ctx, authority);
      throw new ConflictError('The template changed. Reload and retry.', 'TEMPLATE_CONFLICT');
    }
    await audit(ctx, auth, { id, orgId: null }, shared ? 'template.shared' : 'template.unshared');
  }
  return detail(ctx, auth, id);
}
