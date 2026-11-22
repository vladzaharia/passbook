import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  CreatedScanningDeviceSchema,
  CreateScanningDeviceSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';
import { credentialOnce, withoutSecrets } from './credential-once.ts';
import { charged } from './key-credentials.ts';
import { createScanningDevice } from './scanning-devices.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import { sessionAuthority } from './target-authority.ts';

type Router = ReturnType<typeof createRouter>;

/**
 * Add a device to a session: a console session, a `scanning:write` key (no code), or a live
 * `scanning:admin` key (the code, once). Registered before the session guard.
 */
export function registerSessionDevices(router: Router): void {
  router.use('/:id/devices', limitBody(64 * 1024));
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/{id}/devices',
      summary: 'Add a device to a scanning session',
      auth: {
        scope: ['scanning:admin', 'scanning:write'],
        capability: 'scanning:manage',
        feature: 'scanning.devices',
      },
      params: IdParamSchema,
      body: CreateScanningDeviceSchema,
      response: CreatedScanningDeviceSchema,
      status: 201,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const auth = authOf(c);
      if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
      const row = await loadScanningSession(ctx, c.req.valid('param').id, modeOf(auth));
      if (auth.kind === 'api_key' && auth.orgId !== row.org_id)
        throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
      const authority =
        auth.kind === 'api_key'
          ? await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:manage')
          : await sessionAuthority(ctx, auth, row.org_id, 'scanning:manage');
      const actorId = auth.kind === 'api_key' ? auth.keyId : currentUserId(c);
      const input = c.req.valid('json');
      const origin = new URL(c.req.url).origin;
      const code = authority.kind === 'api_key' && authority.scope === 'scanning:admin';
      return credentialOnce(c, ctx, {
        orgId: row.org_id,
        body: input,
        status: 201,
        execute: () =>
          charged(ctx, authority, code ? 1 : 0, (committed) =>
            createScanningDevice(
              ctx,
              actorId,
              modeOf(auth),
              row.id,
              input,
              origin,
              authority,
              undefined,
              ipPrefix(clientIp(c)),
              committed,
            ),
          ),
        redact: (v) => withoutSecrets(CreatedScanningDeviceSchema, v, ['pairing']),
      });
    },
  );
}
