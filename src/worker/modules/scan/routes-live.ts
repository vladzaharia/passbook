import { z } from 'zod';
import { ScanLiveSnapshotSchema } from '../../../shared/contracts/scan-setups.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { openMemberPhotoFromSnapshot } from '../passes/member-photo.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { liveAttachment, scanHub } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { prepareLivePhoto } from './live-photo-delivery.ts';
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
    query: z.object({ after: z.string().max(64).optional() }),
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
    const attachment = liveAttachment(ctx, actor);
    const hub = scanHub(ctx, actor.orgId, actor.mode);
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      if (c.req.header('origin') !== new URL(c.req.url).origin)
        throw new ForbiddenError('Open the screen on this site.', 'SCAN_LIVE_ORIGIN');
      const request = new Request(c.req.raw);
      request.headers.set('x-pb-live', await sealLiveAttachment(ctx.env, attachment));
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
    query: z.object({
      g: z.string().min(1).max(100),
      event: z.string().min(1).max(64),
    }),
  },
  async (c) => {
    const initial = serviceContext(c);
    const ctx = { ...initial, env: snapshotCredentialEnv(initial.env) };
    const actor = cloneObservedScanActor(scanActorOf(c));
    const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    const keyset = await credentialRefKeysetCommitment(ctx.env);
    if (
      actor.credentialKeysetCommitment !== undefined &&
      actor.credentialKeysetCommitment !== keyset
    )
      throw missing();
    actor.credentialKeysetCommitment = keyset;
    const attachment = liveAttachment(ctx, actor);
    const { passId } = c.req.valid('param');
    const { g, event } = c.req.valid('query');
    if (attachment.role !== 'monitor') throw missing();
    const hub = scanHub(ctx, actor.orgId, actor.mode);
    const proof = await hub.sourceProof(event);
    if (!proof) throw missing();
    const prepared = await prepareLivePhoto(
      ctx,
      actor,
      attachment,
      passId,
      { eventId: event, sourceProof: proof },
      g,
    );
    if (!prepared) throw missing();
    try {
      const response = await openMemberPhotoFromSnapshot(ctx, prepared.photo);
      try {
        const currentProof = await hub.sourceProof(event);
        if (currentProof !== proof || !(await prepared.recheck())) throw missing();
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
