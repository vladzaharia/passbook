import type { Resolved } from '../../../shared/contracts/developer.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { passInOrg, requestByRequestId, templateInOrg } from './repo-resolve.ts';
import { orgOfCaller } from './request-log-service.ts';

const orgHref = (orgId: string, rest = '') => `/admin/o/${encodeURIComponent(orgId)}${rest}`;

/**
 * What a pasted id names inside the caller's own sandbox: a request first (its row in the log),
 * then a pass, a template or the sandbox itself. The organization is the caller's, never the
 * request's, so an id from anywhere else is simply not found.
 */
export async function resolveId(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  rawId: string,
): Promise<Resolved> {
  const orgId = await orgOfCaller(ctx, auth);
  const id = rawId.toLowerCase();
  const request = await requestByRequestId(ctx.env.DB, orgId, id, ctx.clock.now());
  if (request)
    return {
      kind: 'request',
      href: `/developers/logs#${encodeURIComponent(request.id)}`,
      label: `${request.method} ${request.path.replace(/^\/api\/v1/, '')}, ${request.status}`,
    };
  if (id === orgId.toLowerCase())
    return { kind: 'org', href: orgHref(orgId), label: 'Your sandbox' };
  const pass = await passInOrg(ctx.env.DB, orgId, id);
  if (pass)
    return {
      kind: 'pass',
      href: orgHref(orgId, `/passes/${encodeURIComponent(pass.id)}`),
      label: pass.serial,
    };
  const template = await templateInOrg(ctx.env.DB, orgId, id);
  if (template)
    return {
      kind: 'template',
      href: orgHref(orgId, `/templates/${encodeURIComponent(template.id)}`),
      label: template.name,
    };
  throw new NotFoundError('Nothing with this id in your sandbox.', 'RESOLVE_NOT_FOUND');
}
