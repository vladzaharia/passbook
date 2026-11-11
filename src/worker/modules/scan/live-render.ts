import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { actorCsrfAuthorityStmt } from './actor-csrf.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import {
  cloneLiveAttachment,
  type LiveRecipient,
  liveRecipientAcquisitionStmts,
  liveRecipientFromResults,
} from './live-auth.ts';
import { type LivePassSnapshot, openLiveSourceProof } from './live-provenance.ts';
import { finishLiveRows } from './live-render-final.ts';
import { prepareLiveRow } from './live-render-plan.ts';
import { scannerReleaseAllowed } from './member-photo.ts';
import { byIdStmt, type Candidate } from './repo-lookup.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

function watches(recipient: LiveRecipient, source: string) {
  return (
    recipient.actor.scanner !== null &&
    recipient.actor.scanner.id !== source &&
    (recipient.watch.allOrg || recipient.watch.scannerIds.includes(source))
  );
}

export interface PhotoProof {
  eventId: string;
  sourceProof: string;
  scannerId?: string;
  at?: number;
}

async function boundProof(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  passId: string | null,
  ref: PhotoProof,
  keyset: Promise<string>,
) {
  const [proof, currentKeyset] = await Promise.all([
    openLiveSourceProof(ctx.env, ref.sourceProof),
    keyset,
  ]);
  const sourceId = proof?.actor.scanner?.id;
  if (
    !proof ||
    !sourceId ||
    !proof.actor.role ||
    proof.eventId !== ref.eventId ||
    proof.passId !== passId ||
    (ref.scannerId !== undefined && sourceId !== ref.scannerId) ||
    (ref.at !== undefined && proof.at !== ref.at) ||
    proof.actor.orgId !== recipient.actor.orgId ||
    proof.actor.mode !== recipient.actor.mode ||
    proof.actor.scanner?.deviceRole !== 'scan' ||
    !watches(recipient, sourceId)
  )
    return null;
  if (!(await safeEqual(currentKeyset, proof.credentialContext.credentialKeysetCommitment)))
    return null;
  return { proof, sourceId };
}

export function sameSnapshot(candidate: Candidate, snapshot: LivePassSnapshot | null) {
  return (
    snapshot !== null &&
    snapshot.orgRevision !== null &&
    snapshot.templateRevision !== null &&
    snapshot.identityRevision !== null &&
    Number.isSafeInteger(snapshot.identityRevision) &&
    snapshot.identityRevision > 0 &&
    Number.isSafeInteger(snapshot.credentialGeneration) &&
    snapshot.credentialGeneration > 0 &&
    Number.isSafeInteger(snapshot.lifecycleGeneration) &&
    snapshot.lifecycleGeneration >= 0 &&
    Number.isSafeInteger(snapshot.imageGeneration) &&
    snapshot.imageGeneration >= 0 &&
    snapshot.transferPending === false &&
    candidate.transferPending === false &&
    snapshot.walletVersion !== null &&
    Number.isSafeInteger(snapshot.walletVersion) &&
    snapshot.walletVersion > 0 &&
    scannerReleaseAllowed(candidate) &&
    snapshot.version === candidate.pass.version &&
    snapshot.revision === candidate.pass.revision &&
    snapshot.linkGeneration === candidate.pass.linkGeneration &&
    snapshot.credentialGeneration === candidate.pass.credentialGeneration &&
    snapshot.lifecycleGeneration === candidate.pass.lifecycleGeneration &&
    snapshot.imageGeneration === candidate.pass.imageGeneration &&
    snapshot.credentialKeysetCommitment === candidate.credentialKeysetCommitment &&
    snapshot.credentialTombstoneRefs.length === candidate.credentialTombstoneRefs.length &&
    snapshot.credentialTombstoneRefs.every(
      (ref, index) => ref === candidate.credentialTombstoneRefs[index],
    ) &&
    snapshot.otherModeCredentialTombstoneRefs.length ===
      candidate.otherModeCredentialTombstoneRefs.length &&
    snapshot.otherModeCredentialTombstoneRefs.every(
      (ref, index) => ref === candidate.otherModeCredentialTombstoneRefs[index],
    ) &&
    snapshot.walletVersion === candidate.walletVersion &&
    snapshot.walletTemplateVersion === candidate.walletTemplateVersion &&
    snapshot.walletVersion <= candidate.pass.version &&
    snapshot.passReleaseId === candidate.pass.releaseId &&
    snapshot.connectionGeneration === candidate.connectionGeneration &&
    snapshot.activeTemplateVersion === candidate.activeTemplateVersion &&
    snapshot.displayTemplateVersion === candidate.displayTemplateVersion &&
    (snapshot.activeReleaseId === null ||
      candidate.pass.templateVersion === snapshot.activeReleaseVersion ||
      snapshot.displayTemplateVersion === snapshot.activeReleaseVersion) &&
    snapshot.orgRevision === candidate.orgRevision &&
    snapshot.templateRevision === candidate.templateRevision &&
    snapshot.identityRevision === candidate.identityRevision &&
    snapshot.activeReleaseId === candidate.activeReleaseId &&
    snapshot.activeReleaseGeneration === candidate.activeReleaseGeneration &&
    snapshot.activeReleaseVersion === candidate.activeReleaseVersion &&
    snapshot.activeReleaseCandidateHash === candidate.activeReleaseCandidateHash
  );
}

/** Acquire all watched source, recipient, watch, stamp and candidate rows in one snapshot. */
export async function liveRowsFor(
  context: ServiceContext,
  original: LiveRecipient,
  inputs: readonly ScanLiveRow[],
): Promise<ScanLiveRow[]> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const attachment = cloneLiveAttachment(original.attachment);
  if (!attachment) return [];
  const actor = cloneObservedScanActor(original.actor);
  const originalFences = JSON.stringify(original.fences);
  const recipient: LiveRecipient = {
    ...original,
    actor,
    attachment,
    watch: { allOrg: original.watch.allOrg, scannerIds: [...original.watch.scannerIds] },
  };
  const customer = actor.scanner?.deviceRole === 'customer';
  const entries = inputs
    .map((input) => ({
      row: { ...input },
      sourceProof: (input as ScanLiveRow & { sourceProof?: string }).sourceProof ?? '',
    }))
    .filter(
      ({ row }) =>
        watches(recipient, row.scannerId) &&
        (!customer || (row.presented && ctx.clock.now() - row.at <= 10_000)),
    );
  if (!entries.length) return [];
  const keyset = credentialRefKeysetCommitment(ctx.env);
  const authenticated = await Promise.all(
    entries.map(async ({ row, sourceProof }) => {
      const bound = await boundProof(
        ctx,
        recipient,
        row.passId,
        {
          eventId: row.id,
          sourceProof,
          scannerId: row.scannerId,
          at: row.at,
        },
        keyset,
      );
      return bound ? { row, ...bound } : null;
    }),
  );
  const rows = authenticated.filter((entry) => entry !== null);
  if (!rows.length) return [];
  const reads = liveRecipientAcquisitionStmts(ctx.env.DB, actor);
  const recipientCsrf = actorCsrfAuthorityStmt(ctx.env.DB, actor);
  if (!reads || !recipientCsrf) return [];
  const statements = [reads.watch, reads.stamps, recipientCsrf];
  const acquired = rows
    .map((entry) => {
      const sourceCsrf = actorCsrfAuthorityStmt(ctx.env.DB, entry.proof.actor);
      if (!sourceCsrf) return null;
      const sourceIndex = statements.push(sourceCsrf) - 1;
      const candidateIndex = entry.row.passId
        ? statements.push(byIdStmt(ctx.env.DB, entry.proof.actor.orgId, entry.row.passId)) - 1
        : null;
      return { ...entry, sourceIndex, candidateIndex };
    })
    .filter((entry) => entry !== null);
  if (!acquired.length) return [];
  const results = await ctx.env.DB.batch(statements);
  if (
    results.length !== statements.length ||
    ![0, 1, 2].every((index) => results[index]?.success === true)
  )
    return [];
  const healthy = acquired.filter(
    ({ sourceIndex, candidateIndex }) =>
      results[sourceIndex]?.success === true &&
      (candidateIndex === null || results[candidateIndex]?.success === true),
  );
  const observed = liveRecipientFromResults(ctx, actor, attachment, {
    watch: results[0],
    stamps: results[1],
  });
  if (!observed || JSON.stringify(observed.fences) !== originalFences) return [];
  const plans = await Promise.all(
    healthy.map(({ row, proof, sourceId, sourceIndex, candidateIndex }) =>
      watches(observed, sourceId)
        ? prepareLiveRow(
            ctx,
            observed,
            row,
            proof,
            sourceId,
            candidateIndex === null ? undefined : results[candidateIndex],
            { sourceResult: results[sourceIndex], recipientResult: results[2] },
            sameSnapshot,
          )
        : Promise.resolve(null),
    ),
  );
  const projected = await finishLiveRows(ctx, observed, plans);
  return customer
    ? projected.filter((row) => row.presented && ctx.clock.now() - row.at <= 10_000)
    : projected;
}

/** A single live event uses the same batched acquisition and final CAS as catch-up. */
export async function liveRowFor(
  context: ServiceContext,
  original: LiveRecipient,
  input: ScanLiveRow,
): Promise<ScanLiveRow | null> {
  return (await liveRowsFor(context, original, [input]))[0] ?? null;
}
