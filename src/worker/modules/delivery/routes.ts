import { z } from 'zod';
import { DeliveryEntrySchema, IdSchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const deliveryRoutes = createRouter();
guard(deliveryRoutes, requireAdmin);
stub(deliveryRoutes, 'delivery', {
  method: 'get',
  path: '/',
  summary: 'Outbox entries for a pass',
  query: z.object({ passId: IdSchema }),
  response: z.object({ items: z.array(DeliveryEntrySchema) }),
});
