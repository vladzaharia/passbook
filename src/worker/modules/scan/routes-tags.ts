import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  ScanTagBindRequestSchema,
  ScanTagBindResultSchema,
  ScanTagInspectRequestSchema,
  ScanTagInspectResponseSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { bindOnScanner } from './tags-bind.ts';
import { inspectTag } from './tags-inspect.ts';
import { undoOnScanner } from './tags-undo.ts';

/** Assign tag on a scanner: `/api/v1/scan/tags`. Desk and up; the service refuses the rest. */
export function registerScanTagRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use('/tags/*', requireScanActor({ capability: 'passes:operate' }));

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/tags/inspect',
      summary: 'What a tag is now',
      body: ScanTagInspectRequestSchema,
      response: ScanTagInspectResponseSchema,
    },
    async (c) =>
      c.json(await inspectTag(serviceContext(c), scanActorOf(c), c.req.valid('json').tag)),
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/tags/bind',
      summary: 'Assign a tag to a card, or preview it',
      body: ScanTagBindRequestSchema,
      response: ScanTagBindResultSchema,
    },
    async (c) =>
      c.json(await bindOnScanner(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/tags/bindings/{bindingId}/undo',
      summary: 'Undo an assigned tag',
      params: z.object({ bindingId: z.string().min(1).max(64) }),
      response: z.object({ status: z.literal('undone'), bindingId: z.string() }),
    },
    async (c) =>
      c.json(
        await undoOnScanner(serviceContext(c), scanActorOf(c), c.req.valid('param').bindingId),
      ),
  );
}
