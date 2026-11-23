import { z } from 'zod';
import { CursorQuerySchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  SetWalletEnrolmentSourceSchema,
  WalletEnrolmentActionSchema,
  WalletEnrolmentListSchema,
  WalletEnrolmentParamsSchema,
  WalletEnrolmentSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import { listEnrolments } from './enrolment-read.ts';
import {
  disableEnrolment,
  enableEnrolment,
  revokeEnrolment,
  setEnrolmentSource,
} from './enrolment-service.ts';

/** Mount at /api/v1/orgs. The session's mode picks the enrolment; Test and Live are separate rows. */
export const walletEnrolmentRoutes = createRouter();
guard(walletEnrolmentRoutes, requireTenantSession);
walletEnrolmentRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

register(
  walletEnrolmentRoutes,
  'wallet enrolments',
  {
    method: 'get',
    path: '/{orgId}/wallet-enrolments',
    summary: 'List the wallet provider enrollments of the session mode',
    params: z.strictObject({ orgId: IdSchema }),
    query: CursorQuerySchema,
    response: WalletEnrolmentListSchema,
  },
  async (c) =>
    c.json(await listEnrolments(serviceContext(c), sessionOf(c), c.req.valid('param').orgId)),
);

register(
  walletEnrolmentRoutes,
  'wallet enrolments',
  {
    method: 'put',
    path: '/{orgId}/wallet-enrolments/{provider}',
    summary: 'Pick the credential source of a provider',
    params: WalletEnrolmentParamsSchema,
    body: SetWalletEnrolmentSourceSchema,
    response: WalletEnrolmentSchema,
  },
  async (c) => {
    const { orgId, provider } = c.req.valid('param');
    return c.json(
      await setEnrolmentSource(
        serviceContext(c),
        sessionOf(c),
        orgId,
        provider,
        c.req.valid('json'),
      ),
    );
  },
);

const actions = { enable: enableEnrolment, disable: disableEnrolment, revoke: revokeEnrolment };
for (const [name, run] of Object.entries(actions))
  register(
    walletEnrolmentRoutes,
    'wallet enrolments',
    {
      method: 'post',
      path: `/{orgId}/wallet-enrolments/{provider}/${name}`,
      summary: `${name[0]?.toUpperCase()}${name.slice(1)} a wallet provider enrollment`,
      params: WalletEnrolmentParamsSchema,
      body: WalletEnrolmentActionSchema,
      response: WalletEnrolmentSchema,
    },
    async (c) => {
      const { orgId, provider } = c.req.valid('param');
      return c.json(
        await run(serviceContext(c), sessionOf(c), orgId, provider, c.req.valid('json')),
      );
    },
  );
