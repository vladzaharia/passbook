import { z } from 'zod';
import { DeliveryEntrySchema, IdSchema } from '../../../shared/contracts/index.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  authOf,
  passScopeOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { listPassDeliveries } from './service.ts';

export const deliveryRoutes = createRouter();
guard(deliveryRoutes, requireTenantSessionOrApiKey('passes:read'));

const query = z.object({ orgId: IdSchema, passId: IdSchema });

register(
  deliveryRoutes,
  'delivery',
  {
    method: 'get',
    path: '/',
    summary: 'Outbox entries for a pass',
    query,
    response: z.object({ items: z.array(DeliveryEntrySchema) }),
  },
  async (c) => {
    const { orgId, passId } = c.req.valid('query');
    const ctx = serviceContext(c);
    const pass = await getPass(ctx.env.DB, passId, passScopeOf(c));
    if (!pass || pass.orgId !== orgId) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    let authority: TenantPassWrite;
    try {
      authority = await tenantAuthorityOf(ctx, authOf(c), pass.orgId, 'passes:read');
    } catch (error) {
      if (error instanceof ForbiddenError)
        throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
      throw error;
    }
    const rows = await listPassDeliveries(ctx, passId, authority);
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        attempts: r.attempts,
        errorCode: r.errorCode,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      })),
    });
  },
);
