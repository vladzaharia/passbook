import { OrgIdParamSchema } from '../../../shared/contracts/identities.ts';
import { PassSetupSchema } from '../../../shared/contracts/pass-setup.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';
import { getPassSetup } from './pass-setup.ts';

const noStore = async (
  c: { header: (name: string, value: string) => void },
  next: () => Promise<void>,
) => {
  await next();
  c.header('cache-control', 'no-store');
};

/**
 * Mount at /api/v1/orgs, ahead of `orgsRoutes` (whose guard admits sessions only). The read of an organization's brand,
 * channels and accounts; its write is in `pass-setup-write-routes.ts`. A key reads with `org:read` or `brand:manage`. Responses are never cached.
 */
export const passSetupRoutes = createRouter();
passSetupRoutes.use('/:orgId/pass-setup', noStore);

register(
  passSetupRoutes,
  'pass setup',
  {
    method: 'get',
    path: '/{orgId}/pass-setup',
    summary: "Read an organization's brand, channels and accounts in the caller's mode",
    params: OrgIdParamSchema,
    response: PassSetupSchema,
    auth: { scope: ['org:read', 'brand:manage'], capability: 'org:read' },
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    const ctx = serviceContext(c);
    const auth = authOf(c);
    await tenantAuthorityOf(ctx, auth, orgId, 'org:read');
    return c.json((await getPassSetup(ctx, auth, orgId)).view);
  },
);
