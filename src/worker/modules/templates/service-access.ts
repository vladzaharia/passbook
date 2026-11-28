import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { requireNotPersonal } from '../orgs/personal-guard.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getTemplate, type TemplateRow } from './repo.ts';
import { templateVisibleToOrg } from './repo-list.ts';
import { syncBakedTemplates } from './sync.ts';

export function requireTemplateReader(
  auth: AuthContext | undefined,
): asserts auth is Exclude<AuthContext, { kind: 'scanner' }> {
  if (!auth || auth.kind === 'scanner') throw new UnauthenticatedError();
  if (auth.kind === 'api_key' && !auth.scopes.includes('templates:read'))
    throw new ForbiddenError('The API key lacks the templates:read scope.', 'MISSING_SCOPE');
}

/** An org-less platform key is not tenant authority: a personal org's templates are not its to read. */
async function refusePersonalForPlatformKey(
  ctx: ServiceContext,
  auth: Extract<AuthContext, { kind: 'api_key' }>,
  orgId: string,
  notFound?: () => NotFoundError,
): Promise<void> {
  if (auth.orgId !== null) return;
  try {
    await requireNotPersonal(ctx.env.DB, orgId);
  } catch (error) {
    if (notFound && error instanceof ForbiddenError) throw notFound();
    throw error;
  }
}

/** The stored org is authoritative; absent membership may be hidden for by-ID reads. */
export async function requireTemplateOrgRead(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  notFound?: () => NotFoundError,
): Promise<void> {
  requireTemplateReader(auth);
  if (auth.kind === 'api_key') {
    if (notFound && auth.orgId !== null && auth.orgId !== orgId) throw notFound();
    assertOrgAccess(auth, orgId);
    await refusePersonalForPlatformKey(ctx, auth, orgId, notFound);
    return;
  }
  if (notFound && !(await getOrgAccess(ctx, auth.userId, orgId))) throw notFound();
  try {
    await tenantAuthorityOf(ctx, auth, orgId, 'templates:read');
  } catch (error) {
    if (
      notFound &&
      error instanceof ForbiddenError &&
      !(await getOrgAccess(ctx, auth.userId, orgId))
    )
      throw notFound();
    throw error;
  }
}

/** Collection scope: undefined is platform-key wide, null is platform rows only. */
export async function templateCollectionOrg(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  requestedOrgId: string | undefined,
): Promise<string | null | undefined> {
  requireTemplateReader(auth);
  if (auth.kind === 'api_key') {
    if (requestedOrgId) {
      assertOrgAccess(auth, requestedOrgId);
      await refusePersonalForPlatformKey(ctx, auth, requestedOrgId);
    }
    return auth.orgId ?? requestedOrgId;
  }
  if (requestedOrgId) {
    await requireTemplateOrgRead(ctx, auth, requestedOrgId);
    return requestedOrgId;
  }
  if (!auth.roles.includes('admin'))
    throw new ValidationError('An organization is required.', [], 'ORG_REQUIRED');
  return null;
}

/** A signed-in platform administrator sees pass counts across every org for shared templates. */
export function isPlatformAdmin(auth: AuthContext | undefined): boolean {
  return auth?.kind === 'session' && auth.roles.includes('admin');
}

/** A platform administrator session or a platform (org-less) API key: the principals of platform-wide data. */
export function isPlatformPrincipal(auth: AuthContext | undefined): boolean {
  return isPlatformAdmin(auth) || (auth?.kind === 'api_key' && auth.orgId === null);
}

/** Count only the selected or stored tenant's passes, unless a platform key has global access. */
export function passUsageOrg(
  auth: AuthContext | undefined,
  templateOrgId: string | null,
  selectedOrgId: string | undefined,
): string | null | undefined {
  if (auth?.kind === 'api_key') return auth.orgId ?? undefined;
  const org = templateOrgId ?? selectedOrgId;
  if (org) return org;
  return isPlatformAdmin(auth) ? undefined : null;
}

/** Loads a template only after checking its stored organization. */
export async function loadTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId?: string,
  options?: { useOrgForGlobalOnly?: boolean },
): Promise<TemplateRow> {
  requireTemplateReader(auth);
  if (orgId && auth.kind === 'api_key') assertOrgAccess(auth, orgId);
  await syncBakedTemplates(ctx);
  const row = await getTemplate(ctx.env.DB, id);
  const notFound = () => new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if (!row || row.status === 'deleted') throw notFound();
  const selectedOrgId = options?.useOrgForGlobalOnly && row.orgId !== null ? undefined : orgId;
  if (selectedOrgId && row.orgId !== null && row.orgId !== selectedOrgId) throw notFound();
  if (selectedOrgId) await requireTemplateOrgRead(ctx, auth, selectedOrgId, notFound);
  else if (row.orgId) await requireTemplateOrgRead(ctx, auth, row.orgId, notFound);
  else if (auth.kind === 'session' && !auth.roles.includes('admin')) {
    // Without an org the caller cannot hold a release: a staged upload is as unknown as a missing id.
    if (row.origin === 'uploaded' && !row.shared) throw notFound();
    throw new ValidationError(
      'An organization is required to access this template.',
      [],
      'ORG_REQUIRED',
    );
  }
  // A tenant sees a platform upload only once it is shared or the org works with it; a staged one is for the platform.
  const tenantOrg = selectedOrgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
  if (
    row.orgId === null &&
    row.origin === 'uploaded' &&
    !row.shared &&
    !isPlatformPrincipal(auth) &&
    !(tenantOrg && (await templateVisibleToOrg(ctx.env.DB, row.id, tenantOrg)))
  )
    throw notFound();
  return row;
}
