import {
  EnableReadyResultSchema,
  EnableReadySchema,
  WalletReleaseParamsSchema,
  WalletReleaseReportSchema,
} from '../../../shared/contracts/wallet-release.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { enableReady, releaseReport } from './release-readiness.ts';

/**
 * Mount at /api/v1/platform before the router-level `requireAdmin` of the wallet platform routes, which ignores a
 * Bearer key: the report and the dry run take a Platform key, the apply is a person's (the owner's go/no-go).
 */
export const walletReleaseRoutes = createRouter();
walletReleaseRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  walletReleaseRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-release',
    summary: 'Read what Google and Samsung would issue once released, per mode',
    response: WalletReleaseReportSchema,
    auth: { platform: 'platform:wallet', key: true },
  },
  async (c) => {
    platformActorOf(c);
    return c.json(await releaseReport(serviceContext(c)));
  },
);

register(
  walletReleaseRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-release/{provider}/{mode}/enable-ready',
    summary:
      'Turn on the reviewed ready enrollments of a released provider (dry run unless apply; a key may only dry run)',
    params: WalletReleaseParamsSchema,
    body: EnableReadySchema,
    response: EnableReadyResultSchema,
    // Refused unless provably a dry run: the schema default fills `apply` in after this runs.
    auth: {
      platform: 'platform:wallet',
      key: {
        unless: (_c, body) =>
          !(body !== null && (body.apply === undefined || body.apply === false)),
      },
      // Turning on enrolments across orgs needs a recent sign-in, as the preset editor and identity runs do.
      stepUp: { maxAgeSec: STEP_UP_SECONDS },
    },
  },
  async (c) => {
    const { provider, mode } = c.req.valid('param');
    return c.json(
      await enableReady(
        serviceContext(c),
        platformActorOf(c, { scope: 'platform:wallet' }),
        provider,
        mode,
        c.req.valid('json'),
      ),
    );
  },
);
