import type { ScanActor } from './actor.ts';
import type { Found } from './resolve.ts';

/** Capture exactly the mutable scope used to bind a finalized display to its original owner. */
export function captureDisplayHistoryScope(actor: ScanActor, found: Found): readonly unknown[] {
  return structuredClone([
    actor.principal,
    actor.orgId,
    actor.mode,
    actor.credentialKeysetCommitment,
    actor.actorKey,
    actor.actor.type,
    actor.actor.id,
    actor.role,
    actor.scanner?.id ?? null,
    actor.scanner?.updatedAt ?? null,
    actor.event?.id ?? null,
    actor.event?.updatedAt ?? null,
    actor.scanningSession?.id ?? null,
    actor.scanningSession?.status ?? null,
    actor.scanningSession?.updatedAt ?? null,
    actor.staff?.id ?? null,
    actor.staff?.updatedAt ?? null,
    actor.templateIds,
    actor.timeZone,
    actor.invalidScannerScope ?? false,
    actor.adminEventTemplates ?? false,
    actor.settings,
    actor.scannerAssignment?.scannerId ?? null,
    actor.scannerAssignment?.orgId ?? null,
    actor.scannerAssignment?.mode ?? null,
    actor.scannerAssignment?.eventId ?? null,
    actor.scannerAssignment?.event?.updatedAt ?? null,
    actor.scannerAssignment?.templateIds ?? null,
    actor.scannerAssignment?.templateRows ?? null,
    actor.scannerAssignment?.structurallyValid ?? null,
    found.pass.id,
    found.pass.orgId,
    found.pass.mode,
    found.pass.templateId,
    found.pass.templateVersion,
    found.pass.identityId,
    found.pass.version,
    found.pass.revision,
    found.pass.linkGeneration,
    found.pass.credentialGeneration,
    found.pass.lifecycleGeneration,
    found.pass.imageGeneration,
    found.pass.releaseId,
    found.transferPending,
    found.credentialTombstoneRefs,
    found.otherModeCredentialTombstoneRefs,
    found.credentialKeysetCommitment,
    found.activeReleaseId,
    found.activeReleaseGeneration,
    found.activeReleaseVersion,
    found.activeReleaseCandidateHash,
    found.orgRevision,
    found.templateRevision,
  ]);
}

export function sameDisplayHistoryScope(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameDisplayHistoryScope(a[key], b[key]))
  );
}
