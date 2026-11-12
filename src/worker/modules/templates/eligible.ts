import type {
  EligibleTemplateList,
  EligibleTemplateQuery,
} from '../../../shared/contracts/template-releases.ts';
import { type AuthContext, assertOrgAccess, modeOf } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { tenantAuthorityOf, tenantKeyScopeOf } from '../passes/http.ts';
import { listEligibleReleases } from './repo-eligible.ts';

/** Compact, scoped picker choices; the selected release is revalidated at issuance. */
export async function eligibleTemplates(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: EligibleTemplateQuery,
): Promise<EligibleTemplateList> {
  if (!auth || auth.kind === 'scanner') throw new UnauthenticatedError();
  if (query.provider !== 'apple')
    throw new ConflictError(
      'This wallet provider is not configured for template releases.',
      'TEMPLATE_PROVIDER_UNSUPPORTED',
    );
  if (query.mode !== modeOf(auth))
    throw new ForbiddenError(
      'The requested mode does not match the current session.',
      'TEMPLATE_MODE_MISMATCH',
    );

  let capability: 'templates:read' | 'passes:read';
  if (auth.kind === 'api_key') {
    assertOrgAccess(auth, query.orgId);
    const scope = tenantKeyScopeOf(auth);
    if (scope !== 'templates:read' && scope !== 'passes:read') throw new ForbiddenError();
    capability = scope;
  } else {
    const membership = await getOrgAccess(ctx, auth.userId, query.orgId);
    if (membership?.capabilities.includes('templates:read')) capability = 'templates:read';
    else if (membership?.capabilities.includes('passes:read')) capability = 'passes:read';
    else throw new ForbiddenError();
  }
  const authority = await tenantAuthorityOf(ctx, auth, query.orgId, capability);
  return listEligibleReleases(ctx.env.DB, query, authority, ctx.clock.now());
}
