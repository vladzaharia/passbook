import { z } from 'zod';
import { CursorQuerySchema, IdSchema } from '../../../shared/contracts/common.ts';
import { SetSamsungCardSchema } from '../../../shared/contracts/wallet-provider-actions.ts';
import {
  HoldWalletEnrolmentSchema,
  PlatformWalletCredentialCheckParamsSchema,
  PlatformWalletEnrolmentListSchema,
  PlatformWalletEnrolmentParamsSchema,
  PlatformWalletEnrolmentQuerySchema,
  ResolveWalletMigrationSchema,
  RevokeWalletCredentialSchema,
  SavePlatformWalletCredentialSchema,
  WalletCredentialCheckQueuedSchema,
  WalletCredentialCheckResultSchema,
  WalletCredentialListSchema,
  WalletCredentialSchema,
  WalletEnrolmentHoldResultSchema,
  WalletMigrationQueuedSchema,
  WalletMigrationReportQuerySchema,
  WalletMigrationReportSchema,
  WalletMigrationResolvedSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf } from '../passes/http.ts';
import { readCredentialCheck, requestCredentialCheck } from './account-check-request.ts';
import { setPlatformSamsungCard } from './credential-cards.ts';
import { migrationReport, queueMigration } from './credential-migrate.ts';
import { resolveMigration } from './credential-migrate-resolve.ts';
import {
  listPlatformCredentials,
  revokePlatformCredential,
  savePlatformCredential,
} from './credential-service.ts';
import { holdEnrolment, releaseEnrolment } from './enrolment-hold.ts';
import { listPlatformEnrolments } from './enrolment-platform-read.ts';
import { googleManagedPlatformRoutes } from './routes-google-managed.ts';

/** Mount at /api/v1/platform. Platform admins only; the pages show Live and Test together, so the mode is named. */
export const walletPlatformRoutes = createRouter();
guard(walletPlatformRoutes, requireAdmin);
walletPlatformRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

walletPlatformRoutes.route('/', googleManagedPlatformRoutes);

const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-credentials',
    summary: 'List the platform wallet credentials',
    query: CursorQuerySchema,
    response: WalletCredentialListSchema,
  },
  async (c) => c.json(await listPlatformCredentials(serviceContext(c), sessionOf(c))),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'put',
    path: '/wallet-credentials',
    summary: 'Create or rotate a platform wallet credential',
    body: SavePlatformWalletCredentialSchema,
    response: WalletCredentialSchema,
  },
  async (c) =>
    c.json(await savePlatformCredential(serviceContext(c), sessionOf(c), c.req.valid('json'))),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'put',
    path: '/wallet-credentials/{id}/cards',
    summary: 'Name the Samsung card of one more type on a platform credential',
    params: z.strictObject({ id: IdSchema }),
    body: SetSamsungCardSchema,
    response: WalletCredentialSchema,
  },
  async (c) =>
    c.json(
      await setPlatformSamsungCard(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-credentials/{id}/revoke',
    summary: 'Revoke a platform wallet credential',
    params: z.strictObject({ id: IdSchema }),
    body: RevokeWalletCredentialSchema,
    response: WalletCredentialSchema,
  },
  async (c) =>
    c.json(
      await revokePlatformCredential(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-credentials/{id}/check',
    summary: 'Check a platform wallet credential with its provider',
    params: z.strictObject({ id: IdSchema }),
    response: WalletCredentialCheckQueuedSchema,
  },
  async (c) =>
    c.json(
      await requestCredentialCheck(
        serviceContext(c),
        sessionOf(c),
        { orgId: null },
        c.req.valid('param').id,
      ),
    ),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-credentials/{id}/checks/{checkId}',
    summary: 'Read the result of a platform wallet credential check',
    params: PlatformWalletCredentialCheckParamsSchema,
    response: WalletCredentialCheckResultSchema,
  },
  async (c) => {
    const { id, checkId } = c.req.valid('param');
    return c.json(
      await readCredentialCheck(serviceContext(c), sessionOf(c), { orgId: null }, id, checkId),
    );
  },
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/orgs/{orgId}/wallet-enrolments/{mode}/{provider}/hold',
    summary: 'Hold a wallet provider enrollment',
    params: PlatformWalletEnrolmentParamsSchema,
    body: HoldWalletEnrolmentSchema,
    response: WalletEnrolmentHoldResultSchema,
  },
  async (c) => {
    const status = await holdEnrolment(
      serviceContext(c),
      sessionOf(c),
      c.req.valid('param'),
      c.req.valid('json').reason,
    );
    return c.json({ status });
  },
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/orgs/{orgId}/wallet-enrolments/{mode}/{provider}/release',
    summary: 'Release a held wallet provider enrollment',
    params: PlatformWalletEnrolmentParamsSchema,
    response: WalletEnrolmentHoldResultSchema,
  },
  async (c) =>
    c.json({
      status: await releaseEnrolment(serviceContext(c), sessionOf(c), c.req.valid('param')),
    }),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-enrolments',
    summary: 'List every organization enrollment of a wallet provider',
    query: PlatformWalletEnrolmentQuerySchema.extend(CursorQuerySchema.shape),
    response: PlatformWalletEnrolmentListSchema,
  },
  async (c) =>
    c.json(
      await listPlatformEnrolments(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('query').provider,
        c.req.valid('query').limit,
        c.req.valid('query').cursor,
      ),
    ),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'get',
    path: '/wallet-credentials/migrate',
    summary: 'Report the legacy wallet accounts waiting for a credential source',
    query: WalletMigrationReportQuerySchema,
    response: WalletMigrationReportSchema,
  },
  async (c) => {
    const { after, cursor } = c.req.valid('query');
    return c.json(await migrationReport(serviceContext(c), sessionOf(c), cursor ?? after));
  },
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-credentials/migrate',
    summary: 'Queue the migration of legacy wallet accounts onto credential sources',
    response: WalletMigrationQueuedSchema,
  },
  async (c) => c.json({ queued: await queueMigration(serviceContext(c), sessionOf(c)) }),
);

register(
  walletPlatformRoutes,
  'wallet platform',
  {
    method: 'post',
    path: '/wallet-credentials/migrate/resolve',
    summary:
      'Resolve a refused legacy wallet account: assign the platform credential, merge or retire',
    body: ResolveWalletMigrationSchema,
    response: WalletMigrationResolvedSchema,
  },
  async (c) => c.json(await resolveMigration(serviceContext(c), sessionOf(c), c.req.valid('json'))),
);
