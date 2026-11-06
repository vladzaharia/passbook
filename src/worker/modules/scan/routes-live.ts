import { z } from 'zod';
import { ScanLiveSnapshotSchema } from '../../../shared/contracts/scan-setups.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { openMemberPhoto } from '../passes/member-photo.ts';
import { assetGrantValid } from './assets.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { liveAttachment, scanHub } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { canShowMemberPhoto } from './member-photo.ts';

export const scanLiveRoutes = createRouter();
scanLiveRoutes.use('*', requireScanActor({ screens: true, staffOptional: true }));
register(
  scanLiveRoutes,
  'scan',
  {
    method: 'get',
    path: '/',
    summary: 'Live screen connection or catch-up',
    query: z.object({ after: z.string().max(64).optional() }),
    response: ScanLiveSnapshotSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const actor = scanActorOf(c);
    const attachment = liveAttachment(ctx, actor);
    const hub = scanHub(ctx, actor.orgId, actor.mode);
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      if (c.req.header('origin') !== new URL(c.req.url).origin)
        throw new ForbiddenError('Open the screen on this site.', 'SCAN_LIVE_ORIGIN');
      const request = new Request(c.req.raw);
      request.headers.set('x-pb-live', JSON.stringify(attachment));
      return hub.fetch(request);
    }
    c.header('cache-control', 'no-store');
    return c.json(await hub.snapshot(attachment, c.req.valid('query').after));
  },
);
register(
  scanLiveRoutes,
  'scan',
  {
    method: 'get',
    path: '/passes/{passId}/assets/member.png',
    summary: 'Private monitor photo',
    params: z.object({ passId: z.string().min(1).max(64) }),
    query: z.object({ g: z.string().max(100), source: z.string().max(64) }),
  },
  async (c) => {
    const ctx = serviceContext(c);
    const actor = scanActorOf(c);
    const attachment = liveAttachment(ctx, actor);
    const recipient = await liveRecipient(ctx, attachment);
    const { passId } = c.req.valid('param');
    const { g, source } = c.req.valid('query');
    if (
      attachment.role !== 'monitor' ||
      !recipient ||
      (!recipient.watch.allOrg && !recipient.watch.scannerIds.includes(source)) ||
      !(await assetGrantValid(ctx.env, actor.actorKey, passId, g, ctx.clock.now())) ||
      !(await canShowMemberPhoto(ctx, actor, passId))
    )
      throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    return openMemberPhoto(ctx, actor.orgId, passId);
  },
);
