import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  ScanTagEnrollmentCompleteRequestSchema,
  ScanTagEnrollmentDeclinedSchema,
  ScanTagEnrollmentDoneSchema,
  ScanTagEnrollmentPendingSchema,
} from '../../../shared/contracts/nfc-tag-enrollments.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { completeEnrollment } from './enrollment-complete.ts';
import { declineEnrollment, pendingEnrollment } from './enrollment-device.ts';
import { requireScanActor, scanActorOf } from './guard.ts';

const IdParam = z.object({ id: z.string().min(1).max(64) });

/** What an admin asked this device to read: `/api/v1/scan/tag-enrollments`. Desk and up on a scanner. */
export function registerScanEnrollmentRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use('/tag-enrollments/*', requireScanActor({ capability: 'passes:operate' }));

  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/tag-enrollments/pending',
      summary: 'The tag request waiting for this device',
      response: ScanTagEnrollmentPendingSchema,
    },
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await pendingEnrollment(serviceContext(c), scanActorOf(c)));
    },
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/tag-enrollments/{id}/complete',
      summary: 'Bind the tag this device read to the request',
      params: IdParam,
      body: ScanTagEnrollmentCompleteRequestSchema,
      response: ScanTagEnrollmentDoneSchema,
    },
    async (c) =>
      c.json(
        await completeEnrollment(
          serviceContext(c),
          scanActorOf(c),
          c.req.valid('param').id,
          c.req.valid('json').tag,
        ),
      ),
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/tag-enrollments/{id}/decline',
      summary: 'Turn a tag request down',
      params: IdParam,
      response: ScanTagEnrollmentDeclinedSchema,
    },
    async (c) =>
      c.json(await declineEnrollment(serviceContext(c), scanActorOf(c), c.req.valid('param').id)),
  );
}
