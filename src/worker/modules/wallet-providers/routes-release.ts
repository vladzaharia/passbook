import {
  EnableReadyResultSchema,
  EnableReadySchema,
  WalletReleaseParamsSchema,
  WalletReleaseReportSchema,
} from '../../../shared/contracts/wallet-release.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
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

register(
  walletReleaseRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-release/{provider}/{mode}/enable-ready',
    summary: 'Turn on every ready enrollment of a released provider (dry run unless apply)',
    params: WalletReleaseParamsSchema,
    body: EnableReadySchema,
    response: EnableReadyResultSchema,
  },
  async (c) => {
    const { provider, mode } = c.req.valid('param');
    return c.json(
      await enableReady(serviceContext(c), sessionOf(c), provider, mode, c.req.valid('json').apply),
    );
  },
);
