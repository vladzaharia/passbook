import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  ScanBatchRequestSchema,
  ScanBatchResultSchema,
  ScanRosterSchema,
} from '../../../shared/contracts/scan-session.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { syncBatch } from './batch.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { rosterFor } from './roster.ts';

/** Offline check-in, device API: `/api/v1/scan/roster` and `/batch`. A paired door only; no API key reaches them. */
export function registerScanOfflineRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use('/roster', requireScanActor({ capability: 'passes:operate' }));
  scanRoutes.use('/batch', requireScanActor({ capability: 'passes:operate' }));

  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/roster',
      summary: "This session's offline list",
      query: z.object({
        cursor: z.string().max(128).optional(),
        since: z.coerce.number().int().nonnegative().optional(),
        updatedSince: z.coerce.number().int().nonnegative().optional(),
      }),
      response: ScanRosterSchema,
    },
    async (c) => {
      const { cursor, since, updatedSince } = c.req.valid('query');
      return c.json(
        await rosterFor(
          serviceContext(c),
          scanActorOf(c),
          cursor ?? null,
          updatedSince ?? since ?? null,
        ),
      );
    },
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/batch',
      summary: 'Upload reads queued offline',
      body: ScanBatchRequestSchema,
      response: ScanBatchResultSchema,
    },
    async (c) => c.json(await syncBatch(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
  );
}
