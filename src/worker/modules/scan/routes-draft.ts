import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ScanDraftRefSchema,
  ScanDraftRequestSchema,
  ScanDraftResultSchema,
} from '../../../shared/contracts/scan-draft.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deleteDraft, putDraft } from './draft.ts';
import { scanActorOf } from './guard.ts';

export function registerScanDraftRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  register(
    scanRoutes,
    'scan',
    {
      method: 'put',
      path: '/draft',
      summary: 'Show the amount under review on the customer screen',
      body: ScanDraftRequestSchema,
      response: ScanDraftResultSchema,
    },
    async (c) => c.json(await putDraft(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'delete',
      path: '/draft',
      summary: 'Clear the draft, and the ready card unless keep=ready',
      query: ScanDraftRefSchema,
      response: ScanDraftResultSchema,
    },
    async (c) => c.json(await deleteDraft(serviceContext(c), scanActorOf(c), c.req.valid('query'))),
  );
}
