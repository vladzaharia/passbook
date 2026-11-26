import {
  EnableReadyResultSchema,
  EnableReadySchema,
  WalletReleaseParamsSchema,
  WalletReleaseReportSchema,
} from '../../../shared/contracts/wallet-release.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { authOf } from '../passes/http.ts';
import { enableReady, releaseReport } from './release-readiness.ts';

const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

/** Mounted inside the platform wallet routes (`/api/v1/platform`, platform admins). */
export const walletReleaseRoutes = createRouter();

register(
  walletReleaseRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-release',
    summary: 'Read what Google and Samsung would issue once released, per mode',
    response: WalletReleaseReportSchema,
  },
  async (c) => c.json(await releaseReport(serviceContext(c), sessionOf(c))),
);

// Turning on enrolments across orgs needs a recent sign-in, as the preset editor and identity runs do.
walletReleaseRoutes.post(
  '/wallet-release/:provider/:mode/enable-ready',
  requireStepUp(STEP_UP_SECONDS),
);

register(
  walletReleaseRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-release/{provider}/{mode}/enable-ready',
    summary: 'Turn on the reviewed ready enrollments of a released provider (dry run unless apply)',
    params: WalletReleaseParamsSchema,
    body: EnableReadySchema,
    response: EnableReadyResultSchema,
  },
  async (c) => {
    const { provider, mode } = c.req.valid('param');
    return c.json(
      await enableReady(serviceContext(c), sessionOf(c), provider, mode, c.req.valid('json')),
    );
  },
);
