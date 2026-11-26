import { OrgIdParamSchema } from '../../../shared/contracts/identities.ts';
import { type PassSetup, PassSetupSchema } from '../../../shared/contracts/pass-setup.ts';
import { viaToken } from '../../platform/auth-workbench.ts';
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
 * What the designer draws on a Workbench token: the brand and the channels' state. The Apple identity and
 * its run, the wallet enrollments, the to-do checks and the template list are left out.
 */
function forToken(view: PassSetup): PassSetup {
  return {
    ...view,
    channels: Object.fromEntries(
      Object.entries(view.channels).map(([name, { account: _account, ...rest }]) => [name, rest]),
    ) as PassSetup['channels'],
    apple: { ...view.apple, identity: null, run: null, passesOnShared: 0 },
    templates: [],
    checks: [],
  };
}

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
    const { view } = await getPassSetup(ctx, auth, orgId);
    return c.json(viaToken(auth) ? forToken(view) : view);
  },
);
