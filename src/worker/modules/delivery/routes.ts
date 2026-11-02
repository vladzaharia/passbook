import { z } from 'zod';
import { DeliveryEntrySchema, IdSchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { type C, valid } from '../passes/http.ts';
import { listPassDeliveries } from './service.ts';

export const deliveryRoutes = createRouter();
guard(deliveryRoutes, requireAdmin);

const query = z.object({ passId: IdSchema });

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
  async (c: C) => {
    const { passId } = valid<z.infer<typeof query>>(c, 'query');
    const rows = await listPassDeliveries(serviceContext(c), passId);
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
