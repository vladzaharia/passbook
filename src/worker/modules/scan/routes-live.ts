import { z } from 'zod';
import { ScanLiveSnapshotSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  ScanWhosInListSchema,
  ScanWhosInQuerySchema,
} from '../../../shared/contracts/scan-whos-in.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { openMemberPhotoFromSnapshot } from '../passes/member-photo.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { pinKeysetOrNull } from './keyset-pin.ts';
import { liveAttachment, scanHub } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { prepareLivePhoto } from './live-photo-delivery.ts';
import { whosIn } from './occupancy/whos-in.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

export const scanLiveRoutes = createRouter();
scanLiveRoutes.use(
  '*',
  requireScanActor({ screens: true, staffOptional: true, capability: 'scanning:read' }),
);
register(
  scanLiveRoutes,
  'scan',
  {
    method: 'get',
    path: '/',
    summary: 'Live screen connection or catch-up',
    query: z.object({
      after: z.string().max(64).optional(),
      /** `device`: a scan-role device's control socket (tag requests, overrides); no rows. */
      as: z.enum(['screen', 'device']).optional(),
    }),
    response: ScanLiveSnapshotSchema,
  },
  async (c) => {
    const initial = serviceContext(c);
    const ctx = { ...initial, env: snapshotCredentialEnv(initial.env) };
    const actor = cloneObservedScanActor(scanActorOf(c));
    const keyset = await credentialRefKeysetCommitment(ctx.env);
    if (
      actor.credentialKeysetCommitment !== undefined &&
      actor.credentialKeysetCommitment !== keyset
    )
      throw new ForbiddenError('The scanner credential changed.', 'SCAN_CREDENTIAL_CHANGED');
    actor.credentialKeysetCommitment = keyset;
    const { after, as } = c.req.valid('query');
    const attachment = liveAttachment(ctx, actor, as ?? 'screen');
    const hub = scanHub(ctx, actor.orgId, actor.mode);
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      if (c.req.header('origin') !== new URL(c.req.url).origin)
        throw new ForbiddenError('Open the screen on this site.', 'SCAN_LIVE_ORIGIN');
      const request = new Request(c.req.raw);
      request.headers.set('x-pb-live', await sealLiveAttachment(ctx.env, attachment));
      request.headers.set('x-pb-now', String(ctx.clock.now()));
      return hub.fetch(request);
    }
    c.header('cache-control', 'no-store');
    return c.json(await hub.snapshot(attachment, after, ctx.clock.now()));
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
    query: z.object({
      event: z.string().min(1).max(64),
    }),
  },
  async (c) => {
    const initial = serviceContext(c);
    const ctx = { ...initial, env: snapshotCredentialEnv(initial.env) };
    const actor = cloneObservedScanActor(scanActorOf(c));
    const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    const keyset = await pinKeysetOrNull(initial);
    if (
      keyset === null ||
      (actor.credentialKeysetCommitment !== undefined &&
        actor.credentialKeysetCommitment !== keyset)
    )
      throw missing();
    actor.credentialKeysetCommitment = keyset;
    const attachment = liveAttachment(ctx, actor);
    const { passId } = c.req.valid('param');
    const { event } = c.req.valid('query');
    if (attachment.role !== 'monitor') throw missing();
    const hub = scanHub(ctx, actor.orgId, actor.mode);
    const entry = await hub.ringRow(event, ctx.clock.now());
    if (!entry || entry.row.passId !== passId) throw missing();
    const prepared = await prepareLivePhoto(ctx, attachment, entry);
    if (!prepared) throw missing();
    try {
      const response = await openMemberPhotoFromSnapshot(ctx, prepared.photo);
      try {
        if (!(await prepared.recheck())) throw missing();
      } catch (error) {
        try {
          await response.body?.cancel();
        } catch {
          // A cancellation failure must not replace the authorization error.
        }
        throw error;
      }
      response.headers.delete('etag');
      return response;
    } catch (error) {
      if (error instanceof NotFoundError) throw missing();
      throw error;
    }
  },
);
register(
  scanLiveRoutes,
  'scan',
  {
    method: 'get',
    path: '/inside',
    summary: "Who's in",
    query: ScanWhosInQuerySchema,
    response: ScanWhosInListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    c.header('cache-control', 'no-store');
    return c.json(await whosIn(ctx, cloneObservedScanActor(scanActorOf(c)), c.req.valid('query')));
  },
);
