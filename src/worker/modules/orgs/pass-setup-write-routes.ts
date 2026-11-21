import { OrgIdParamSchema } from '../../../shared/contracts/identities.ts';
import {
  PassSetupPatchQuerySchema,
  PassSetupPatchSchema,
  PassSetupResultSchema,
  StageBrandAssetSchema,
  StagedBrandAssetSchema,
} from '../../../shared/contracts/pass-setup.ts';
import { DEFAULT_BODY_BYTES, limitBody } from '../../platform/body-limit.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';
import { stageBrandAsset } from './pass-setup-stage.ts';
import { patchPassSetup } from './pass-setup-write.ts';

/**
 * Mount at /api/v1/orgs, beside `passSetupRoutes`. A key writes with `org:write` or, for the brand kit alone,
 * `brand:manage`; a session needs `org:manage`.
 */
export const passSetupWriteRoutes = createRouter({ bodyLimit: false });
passSetupWriteRoutes.use('/:orgId/pass-setup', limitBody(DEFAULT_BODY_BYTES));
// One PNG of at most 512 KB, base64, plus JSON overhead.
passSetupWriteRoutes.use('/:orgId/brand-assets', limitBody(1024 * 1024));

const WRITE_SCOPES = ['org:write', 'brand:manage'] as const;

register(
  passSetupWriteRoutes,
  'pass setup',
  {
    method: 'patch',
    path: '/{orgId}/pass-setup',
    summary:
      "Change an organization's brand and which channels it allows; dryRun answers with the impact (Idempotency-Key on an apply)",
    params: OrgIdParamSchema,
    query: PassSetupPatchQuerySchema,
    body: PassSetupPatchSchema,
    response: PassSetupResultSchema,
    auth: { scope: [...WRITE_SCOPES], capability: 'org:manage' },
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    const dryRun = c.req.valid('query').dryRun === 'true';
    const body = c.req.valid('json');
    const ctx = serviceContext(c);
    const auth = authOf(c);
    // Proven before the replay too: a key that lost its scope gets no stored result.
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'org:manage');
    const run = () => patchPassSetup(ctx, requestActor(c), auth, authority, orgId, body, dryRun);
    // A dry run writes nothing, so it has nothing to replay.
    if (dryRun) return c.json(await run(), 200);
    return idempotentJson(
      c,
      ctx,
      {
        orgId,
        mode: auth.kind === 'scanner' ? 'live' : auth.mode,
        principal: principalOf(auth),
        body,
      },
      200,
      run,
    );
  },
);

register(
  passSetupWriteRoutes,
  'pass setup',
  {
    method: 'post',
    path: '/{orgId}/brand-assets',
    summary: 'Stage a logo, icon or web logo PNG; a later pass-setup save names it by its sha',
    params: OrgIdParamSchema,
    body: StageBrandAssetSchema,
    status: 201,
    response: StagedBrandAssetSchema,
    auth: { scope: [...WRITE_SCOPES], capability: 'org:manage' },
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    const ctx = serviceContext(c);
    await tenantAuthorityOf(ctx, authOf(c), orgId, 'org:manage');
    return c.json(await stageBrandAsset(ctx, orgId, c.req.valid('json')), 201);
  },
);
