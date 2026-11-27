import {
  IdentityCertificateListSchema,
  IdentityRunSchema,
  IdParamSchema,
} from '../../../shared/contracts/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { requireOrgAccessOr404 } from './access.ts';
import { listIdentityCertificates } from './cert-admin.ts';
import { getIdentityRow } from './repo.ts';
import { renewIdentity } from './runs-service.ts';

/** Managed identity actions on /api/v1/identities. Platform admins and keys, except the certificate list, which a member reads for their org. */
export function registerManagedRoutes(identitiesRoutes: ReturnType<typeof createRouter>): void {
  register(
    identitiesRoutes,
    'identities',
    {
      method: 'post',
      auth: { platform: 'platform:identities', key: true },
      path: '/{id}/renew',
      summary: 'Get a new certificate now (managed identities)',
      params: IdParamSchema,
      status: 202,
      response: IdentityRunSchema,
    },
    async (c) =>
      c.json(await renewIdentity(serviceContext(c), requestActor(c), c.req.valid('param').id), 202),
  );
  register(
    identitiesRoutes,
    'identities',
    {
      method: 'get',
      path: '/{id}/certificates',
      summary: 'Certificate history of an identity, newest first',
      params: IdParamSchema,
      response: IdentityCertificateListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const row = await getIdentityRow(ctx.env.DB, id);
      if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
      await requireOrgAccessOr404(ctx, c, row.org_id, 'integrations:read', 'IDENTITY_NOT_FOUND');
      return c.json(await listIdentityCertificates(ctx, id));
    },
  );
}
