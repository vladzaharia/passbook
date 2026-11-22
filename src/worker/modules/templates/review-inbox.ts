import type { z } from 'zod';
import type {
  TemplateReviewList,
  TemplateReviewQuerySchema,
} from '../../../shared/contracts/template-releases.ts';
import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { tenantAuthorityOf, tenantKeyScopeOf } from '../passes/http.ts';
import { userNames } from './repo-release-names.ts';
import { listOpenReviews } from './repo-reviews.ts';
import { isPlatformAdmin } from './service-access.ts';

type Query = z.infer<typeof TemplateReviewQuerySchema> & { orgId: string };

function decode(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split(':');
  if (!/^\d+$/.test(at ?? '') || !id)
    throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return { at: Number(at), id };
}

/** Open review requests in an org for a reviewer: newest versions only, the caller's own work left out. */
export async function listTemplateReviews(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: Query,
): Promise<TemplateReviewList> {
  if (!auth || auth.kind === 'scanner') throw new UnauthenticatedError();
  if (auth.kind === 'api_key') {
    assertOrgAccess(auth, query.orgId);
    if (tenantKeyScopeOf(auth) !== 'templates:read') throw new ForbiddenError();
  } else if (
    !(await getOrgAccess(ctx, auth.userId, query.orgId))?.capabilities.includes('templates:read')
  )
    throw new ForbiddenError();
  await tenantAuthorityOf(ctx, auth, query.orgId, 'templates:read');
  const rows = await listOpenReviews(
    ctx.env.DB,
    query.orgId,
    auth.kind === 'session' ? auth.userId : null,
    decode(query.cursor),
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const names = await userNames(
    ctx.env.DB,
    page.map((r) => r.authorId),
    query.orgId,
    isPlatformAdmin(auth),
  );
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      templateId: r.templateId,
      templateName: r.templateName,
      orgId: query.orgId,
      version: r.version,
      requestedBy: names.get(r.authorId) ?? null,
      requestedAt: r.requestedAt,
    })),
    nextCursor: rows.length > query.limit && last ? `${last.requestedAt}:${last.templateId}` : null,
  };
}
