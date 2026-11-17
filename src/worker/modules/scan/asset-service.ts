import { ZodError } from 'zod';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { readBranding } from '../passes/branding.ts';
import { depsOf } from '../passes/deps.ts';
import { openMemberPhotoFromSnapshot } from '../passes/member-photo.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { photoGrantPurpose } from './asset-types.ts';
import {
  assetGrantWellFormed,
  assetWalletActive,
  prepareAssetGrantVerification,
} from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { pinKeysetOrNull } from './keyset-pin.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { photoPolicyForResolved } from './member-photo.ts';
import {
  assetReadCurrent,
  type ScannerAssetResource,
  scannerAssetResourceFromResult,
  scannerAssetResourceStmt,
} from './repo-asset-read.ts';
import { byIdStmt, type Candidate, candidatesOf } from './repo-lookup.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { candidateInScope } from './resolve.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
const imageName = /^[A-Za-z0-9_@.-]{1,100}\.png$/;

/** Select the same override, organization branding, then template order as public assets. */
async function openOrdinaryAsset(
  ctx: ServiceContext,
  candidate: Candidate,
  resource: ScannerAssetResource,
  template: ResolvedTemplate,
  name: string,
): Promise<ReadableStream<Uint8Array>> {
  if (resource.r2_key !== null) {
    if (!resource.sha1) throw missing();
    const object = await ctx.env.BUCKET.get(resource.r2_key);
    if (!object) throw missing();
    return object.body;
  }
  const branding = readBranding(JSON.parse(resource.branding));
  const file = (await brandingFiles(ctx.env.BUCKET, candidate.pass.orgId, branding.images)).find(
    (entry) => entry.name === name,
  );
  if (file) {
    const object = await ctx.env.BUCKET.get(file.r2Key);
    if (!object) throw missing();
    return object.body;
  }
  if (!template.assets.some((entry) => entry.name === name)) throw missing();
  return depsOf(ctx.env).registry.openAsset(template, name);
}

/** Open only a capability-bound asset, fencing the original snapshot before and after R2. */
export async function openScannerAsset(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  name: string,
  grant: string | undefined,
): Promise<Response> {
  // Keep registry/dependency identity on the original context, while every cryptographic
  // operation and SQL fence uses one immutable KEK and DB snapshot for this request.
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const capturedActor = captureActor(actor);
  if (!passId || passId.length > 64 || !imageName.test(name) || (grant?.length ?? 0) > 100)
    throw missing();
  let response: Response | null = null;
  try {
    if (!assetGrantWellFormed(grant)) throw missing();
    const results = await pinned.env.DB.batch([
      byIdStmt(pinned.env.DB, capturedActor.orgId, passId),
      scannerAssetResourceStmt(pinned.env.DB, capturedActor.orgId, passId, name),
    ]);
    const candidate = candidatesOf(results[0])[0];
    const resource = scannerAssetResourceFromResult(results[1]);
    if (
      !candidate ||
      !resource ||
      candidate.transferPending ||
      !candidateInScope(capturedActor, candidate) ||
      !assetWalletActive(candidate, pinned.clock.now())
    )
      throw missing();
    const photo =
      name === 'member.png' ||
      (name === 'thumbnail@3x.png' && candidate.assetPhoto?.includeInPass === 1);
    if (candidate.credentialKeysetCommitment !== (await pinKeysetOrNull(ctx))) throw missing();
    const verified = await prepareAssetGrantVerification(
      pinned,
      capturedActor,
      candidate,
      candidate.connectionGeneration,
      grant,
      undefined,
      photo ? photoGrantPurpose(candidate) : 'read',
      photo,
    );
    if (!verified) throw missing();
    const templates =
      verified.purpose === 'read'
        ? resolveCandidateReadTemplates(candidate)
        : await verifyLiveTemplateSnapshot(ctx, candidate, candidate.templateSnapshot, 'commit');
    if (!templates) throw missing();
    // The pass stays the one the grant was minted for, under the release it was used under, for
    // this actor, at the start and again once the object is open.
    const current = () =>
      assetReadCurrent(
        pinned.env.DB,
        scanReadAuthority(capturedActor, { now: pinned.clock.now() }),
        capturedActor,
        candidate,
        photo,
        verified.credentialRefPrefixes,
      );
    if (
      (photo &&
        !photoPolicyForResolved(
          capturedActor,
          candidate,
          templates.pinned,
          templates.active,
          pinned.clock.now(),
        )) ||
      !(await current())
    )
      throw missing();

    if (photo) {
      if (!candidate.assetPhoto) throw missing();
      response = await openMemberPhotoFromSnapshot(ctx, {
        r2_key: candidate.assetPhoto.key,
        version: candidate.assetPhoto.version,
      });
    } else {
      const body = await openOrdinaryAsset(ctx, candidate, resource, templates.pinned, name);
      response = new Response(body, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    response.headers.delete('etag');
    if (
      !response.body ||
      !assetWalletActive(candidate, pinned.clock.now()) ||
      (photo &&
        !photoPolicyForResolved(
          capturedActor,
          candidate,
          templates.pinned,
          templates.active,
          pinned.clock.now(),
        )) ||
      !(await current())
    )
      throw missing();
    return response;
  } catch (error) {
    if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        ctx.log.warn('scan.asset_cancel_failed', { code: 'SCAN_ASSET_CANCEL_FAILED' });
      }
    }
    if (error instanceof NotFoundError || error instanceof SyntaxError || error instanceof ZodError)
      throw missing();
    throw error;
  }
}
