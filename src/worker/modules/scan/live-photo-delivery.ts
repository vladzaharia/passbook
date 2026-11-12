import { ZodError } from 'zod';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { memberPhotoFromResult, memberPhotoStmt } from '../passes/repo-member-photo.ts';
import type { ScanActor } from './actor.ts';
import { photoGrantPurpose } from './asset-types.ts';
import { assetGrantTokenHash, assetWalletActive, prepareAssetGrantVerification } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import {
  cloneLiveAttachment,
  type LiveAttachment,
  liveRecipientAcquisitionStmts,
  liveRecipientFromResults,
} from './live-auth.ts';
import { livePassCommitmentValid } from './live-pass-commitment.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { type PhotoProof, sameSnapshot } from './live-render.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { photoPolicyForResolved } from './member-photo.ts';
import {
  assetGrantFromResult,
  getAssetGrantStmt,
  prepareStoredAssetGrantFence,
} from './repo-asset-grants.ts';
import { liveDisclosureCsrfStmts, liveDisclosureCurrent } from './repo-live-authority.ts';
import { livePhotoDeliveryPredicate } from './repo-live-photo-delivery.ts';
import { scanTemplateSnapshotPredicate } from './repo-live-template-snapshot.ts';
import { byIdStmt, type Candidate, candidatesOf } from './repo-lookup.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Request-local only: raw CSRF reads are captured in the closure, never in a DTO or grant. */
export interface PreparedLivePhoto {
  photo: { r2_key: string; version: string };
  recheck(): Promise<boolean>;
}

/** Capture both live principals, watch, candidate, photo and grant in one D1 batch. */
export async function prepareLivePhoto(
  context: ServiceContext,
  recipientActor: ScanActor,
  attachment: LiveAttachment,
  passId: string,
  ref: PhotoProof,
  grant: string,
): Promise<PreparedLivePhoto | null> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(recipientActor);
  const observedRef = { ...ref };
  const capturedAttachment = cloneLiveAttachment(attachment);
  if (!capturedAttachment) return null;
  if (
    actor.scanner?.deviceRole !== 'monitor' ||
    !passId ||
    passId.length > 64 ||
    !observedRef.eventId ||
    !observedRef.sourceProof ||
    !grant ||
    grant.length > 100 ||
    typeof actor.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actor.credentialKeysetCommitment)
  )
    return null;
  try {
    const [proof, tokenHash, keyset] = await Promise.all([
      openLiveSourceProof(ctx.env, observedRef.sourceProof),
      assetGrantTokenHash(grant),
      credentialRefKeysetCommitment(ctx.env),
    ]);
    if (
      !proof ||
      !tokenHash ||
      !proof.actor.scanner ||
      !proof.actor.role ||
      proof.eventId !== observedRef.eventId ||
      proof.passId !== passId ||
      !proof.passSnapshot ||
      (observedRef.scannerId !== undefined && proof.actor.scanner.id !== observedRef.scannerId) ||
      (observedRef.at !== undefined && proof.at !== observedRef.at) ||
      proof.actor.orgId !== actor.orgId ||
      proof.actor.mode !== actor.mode ||
      proof.actor.scanner.deviceRole !== 'scan' ||
      !(await safeEqual(keyset, proof.credentialContext.credentialKeysetCommitment)) ||
      actor.credentialKeysetCommitment !== proof.credentialContext.credentialKeysetCommitment
    )
      return null;

    const recipientStmts = liveRecipientAcquisitionStmts(ctx.env.DB, actor);
    const csrfStmts = liveDisclosureCsrfStmts(ctx.env.DB, proof.actor, actor);
    if (!recipientStmts || !csrfStmts.source || !csrfStmts.recipient) return null;
    const results = await ctx.env.DB.batch([
      recipientStmts.watch,
      recipientStmts.stamps,
      byIdStmt(ctx.env.DB, actor.orgId, passId),
      memberPhotoStmt(ctx.env.DB, actor.orgId, passId),
      getAssetGrantStmt(ctx.env.DB, tokenHash, actor.orgId, actor.mode, ctx.clock.now()),
      csrfStmts.source,
      csrfStmts.recipient,
    ]);
    if (results.length !== 7 || results.some((result) => result?.success !== true)) return null;
    const recipient = liveRecipientFromResults(ctx, actor, capturedAttachment, {
      watch: results[0],
      stamps: results[1],
    });
    const candidates = candidatesOf(results[2]);
    const loaded = candidates.length === 1 ? candidates[0] : null;
    const photo = memberPhotoFromResult(results[3]);
    const stored = assetGrantFromResult(results[4]);
    if (
      !recipient ||
      !loaded ||
      !photo ||
      !stored ||
      loaded.credentialKeysetCommitment !== proof.credentialContext.credentialKeysetCommitment ||
      (!recipient.watch.allOrg && !recipient.watch.scannerIds.includes(proof.actor.scanner.id))
    )
      return null;
    const candidate: Candidate = {
      ...loaded,
      credentialKeysetCommitment: proof.credentialContext.credentialKeysetCommitment,
      credentialTombstoneRefs: proof.credentialContext.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: proof.credentialContext.otherModeCredentialTombstoneRefs,
    };
    if (
      !candidate.assetPhoto ||
      photo.pass_id !== passId ||
      photo.org_id !== actor.orgId ||
      !Number.isSafeInteger(photo.size) ||
      photo.size < 1 ||
      photo.size > 1_000_000 ||
      !Number.isSafeInteger(photo.crc32) ||
      !Number.isSafeInteger(photo.updated_at) ||
      photo.r2_key !== candidate.assetPhoto.key ||
      photo.version !== candidate.assetPhoto.version ||
      photo.sha1 !== candidate.assetPhoto.sha1 ||
      photo.include_in_pass !== candidate.assetPhoto.includeInPass ||
      !assetWalletActive(candidate, ctx.clock.now()) ||
      !sameSnapshot(candidate, proof.passSnapshot) ||
      !(await livePassCommitmentValid(ctx.env, candidate, proof.passSnapshot.passCommitment))
    )
      return null;
    // The same purpose rule as the live row (`live-render-plan.ts`): a pass on its own release
    // under an incompatible head is read, as the device card reads it.
    const purpose = photoGrantPurpose(candidate);
    const templates = await verifyLiveTemplateSnapshot(
      ctx,
      candidate,
      candidate.templateSnapshot,
      purpose,
    );
    if (!templates) return null;
    const verified = await prepareAssetGrantVerification(
      ctx,
      recipient.actor,
      candidate,
      candidate.connectionGeneration,
      grant,
      stored,
      { sourceId: proof.actor.scanner.id, eventId: observedRef.eventId, actor: proof.actor },
      purpose,
      true,
    );
    if (
      !verified ||
      verified.credentialTombstoneRefs.length !==
        proof.credentialContext.credentialTombstoneRefs.length ||
      verified.credentialTombstoneRefs.some(
        (value, index) => value !== proof.credentialContext.credentialTombstoneRefs[index],
      )
    )
      return null;
    const original = { ...candidate, credentialTombstoneRefs: verified.credentialTombstoneRefs };
    const grantFence = await prepareStoredAssetGrantFence(ctx, verified, original);
    const templateFence = scanTemplateSnapshotPredicate(
      candidate,
      candidate.templateSnapshot,
      purpose,
    );
    if (!grantFence || templateFence.sql === '0') return null;
    const extra = (now: number) => [
      templateFence,
      livePhotoDeliveryPredicate(grantFence(now), photo),
    ];
    const check = async (verifyBytes: boolean): Promise<boolean> => {
      if (
        verifyBytes &&
        !(await verifyLiveTemplateSnapshot(ctx, candidate, candidate.templateSnapshot, purpose))
      )
        return false;
      const now = ctx.clock.now();
      if (
        !assetWalletActive(candidate, now) ||
        !photoPolicyForResolved(proof.actor, candidate, templates.pinned, templates.active, now) ||
        !photoPolicyForResolved(
          recipient.actor,
          candidate,
          templates.pinned,
          templates.active,
          now,
          proof.actor.role,
        )
      )
        return false;
      return liveDisclosureCurrent(
        ctx,
        {
          source: proof.actor,
          recipient,
          credentialContext: proof.credentialContext,
          candidate,
          requirePhoto: true,
          extra,
        },
        { sourceResult: results[5], recipientResult: results[6] },
      );
    };
    if (!(await check(false))) return null;
    return { photo: { r2_key: photo.r2_key, version: photo.version }, recheck: () => check(true) };
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return null;
    throw error;
  }
}
