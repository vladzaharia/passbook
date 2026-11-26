import {
  IdentityRunSchema,
  IdParamSchema,
  RevokeCertificateSchema,
} from '../../../shared/contracts/index.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { requireOidcSession } from './access.ts';
import { requestCertificateRevoke } from './cert-admin.ts';

/**
 * Mount at /api/v1/identities before `identitiesRoutes`, whose `requireAdmin` ignores a Bearer key. Revoking a
 * certificate is irreversible (every pass it signed stops updating): a person's call, so a Platform key gets
 * 403 PERSON_REQUIRED, and a person needs a recent sign-in.
 */
export const identityRevokeRoutes = createRouter();

register(
  identityRevokeRoutes,
  'identities',
  {
    method: 'post',
    path: '/{id}/revoke-certificate',
    summary: 'Revoke a superseded certificate after a compromise; needs a Polaris ID sign-in',
    params: IdParamSchema,
    body: RevokeCertificateSchema,
    status: 202,
    response: IdentityRunSchema,
    auth: { platform: 'platform:identities', stepUp: { maxAgeSec: STEP_UP_SECONDS } },
  },
  async (c) => {
    requireOidcSession(c);
    return c.json(
      await requestCertificateRevoke(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      202,
    );
  },
);
