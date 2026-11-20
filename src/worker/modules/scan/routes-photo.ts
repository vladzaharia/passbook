import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { MemberPhotoSchema, PutMemberPhotoSchema } from '../../../shared/contracts/check-in.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { captureDeskPhoto } from './photo-capture.ts';

/** Register on the guarded scanner router, so the device credential stays mandatory. */
export function registerScanPhotoRoute(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'scan',
    {
      method: 'post',
      path: '/passes/{passId}/photo',
      summary: 'Add a member photo from the desk',
      params: z.object({ passId: z.string() }),
      body: PutMemberPhotoSchema,
      response: MemberPhotoSchema,
    },
    async (c) =>
      c.json(
        await captureDeskPhoto(
          serviceContext(c),
          scanActorOf(c),
          c.req.valid('param').passId,
          c.req.valid('json'),
        ),
      ),
  );
}
