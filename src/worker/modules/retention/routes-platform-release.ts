import { OkSchema } from '../../../shared/contracts/common.ts';
import { HoldIdParamsSchema } from '../../../shared/contracts/retention.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { ownUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { releaseHold } from './holds.ts';
import { platformBy } from './routes.ts';

/**
 * Mount at /api/v1/platform. Releasing a legal hold lets a purge run: a person's call, so a Platform key gets 403 PERSON_REQUIRED.
 */
export const retentionPlatformReleaseRoutes = createRouter();
ownUse(retentionPlatformReleaseRoutes, async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  retentionPlatformReleaseRoutes,
  'retention',
  {
    method: 'post',
    path: '/orgs/{orgId}/retention/holds/{holdId}/release',
    summary: 'Release any legal hold',
    params: HoldIdParamsSchema,
    response: OkSchema,
    auth: { platform: 'platform:orgs' },
  },
  async (c) => {
    const { orgId, holdId } = c.req.valid('param');
    await releaseHold(serviceContext(c), orgId, holdId, platformBy(c));
    return c.json({ ok: true as const });
  },
);
