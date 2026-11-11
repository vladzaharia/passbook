import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import { epochsMissing } from './authority-capture.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { LiveAttachment } from './live-auth.ts';
import { livePassSnapshot, sealLiveSourceProof } from './live-provenance.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import { liveCredentialKeyset } from './repo-live.ts';
import type { Candidate } from './repo-lookup.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';

export const scanHub = (ctx: ServiceContext, orgId: string, mode: string) =>
  ctx.env.SCAN_HUB.getByName(`${orgId}:${mode}`);

export function liveAttachment(ctx: ServiceContext, actor: ScanActor): LiveAttachment {
  const row = actor.scanner;
  if (
    actor.terminal ||
    !row ||
    row.orgId !== actor.orgId ||
    row.mode !== actor.mode ||
    typeof actor.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actor.credentialKeysetCommitment) ||
    actor.scannerCsrfProof === undefined ||
    (actor.principal === 'scanner'
      ? !row.tokenHash ||
        typeof actor.scannerCsrfProof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof)
      : !actor.platformSessionId ||
        actor.tenantAuthority?.kind !== 'session' ||
        actor.tenantAuthority.orgId !== actor.orgId ||
        actor.tenantAuthority.userId !== actor.actor.id ||
        actor.tenantAuthority.sessionId !== actor.platformSessionId ||
        actor.tenantAuthority.capability !== 'scanning:read' ||
        actor.tenantAuthority.mode !== actor.mode ||
        !/^[A-Za-z0-9_-]{43}$/.test(actor.tenantAuthority.sessionCsrfProof ?? '') ||
        !(
          actor.scannerCsrfProof === null ||
          (typeof actor.scannerCsrfProof === 'string' &&
            /^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof))
        ))
  )
    throw new UnauthenticatedError('Pair this screen to continue.', 'SCANNER_UNAUTHENTICATED');
  if (row.deviceRole === 'scan')
    throw new ForbiddenError('Choose a screen view in Scanning.', 'SCREEN_REQUIRED');
  const epochs = scanEpochsOf(actor);
  if (!epochs) throw epochsMissing();
  const capturedActor = cloneObservedScanActor(actor);
  const observation = captureObservedScanningSession(capturedActor);
  if (capturedActor.scanningSession && !observation)
    throw new UnauthenticatedError('Pair this screen to continue.', 'SCANNER_UNAUTHENTICATED');
  let expiresAt: number;
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    if (!authority)
      throw new UnauthenticatedError('Pair this screen to continue.', 'SCANNER_UNAUTHENTICATED');
    expiresAt = authority.sessionExpiresAt;
  } else {
    expiresAt = row.expiresAt ?? Infinity;
  }
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    scannerId: row.id,
    role: row.deviceRole,
    tokenHash: row.tokenHash ?? '',
    scannerCsrfProof: actor.scannerCsrfProof,
    credentialKeysetCommitment: actor.credentialKeysetCommitment,
    revision: row.updatedAt,
    session: actor.scanningSession ? { ...actor.scanningSession } : null,
    actor: capturedActor,
    epochs,
    observation,
    expiresAt: Math.min(expiresAt, ctx.clock.now() + 15 * 60_000),
    ...(actor.principal === 'admin' &&
    actor.platformSessionId &&
    actor.tenantAuthority?.kind === 'session'
      ? {
          admin: {
            sessionId: actor.platformSessionId,
            userId: actor.actor.id,
            tenantAuthority: {
              ...actor.tenantAuthority,
              roles: [...actor.tenantAuthority.roles],
              sessionRoles: [...actor.tenantAuthority.sessionRoles],
            },
          },
        }
      : {}),
  };
}

export function publishScan(
  ctx: ServiceContext,
  actor: ScanActor,
  out: ScanOutcome,
  evaluatedSnapshot: Candidate | null,
  credentialContext: CredentialTombstoneSnapshot | null,
  method: string,
  undo = false,
  enteredCode = false,
) {
  if (!actor.scanner || (!actor.scanningSession && !actor.scanner.hasScreens) || out.replay) return;
  const keyset = credentialContext?.credentialKeysetCommitment;
  if (
    typeof keyset !== 'string' ||
    !/^[a-f0-9]{64}$/.test(keyset) ||
    !credentialContext ||
    (actor.credentialKeysetCommitment !== undefined &&
      actor.credentialKeysetCommitment !== keyset) ||
    !validCredentialTombstoneRefs(credentialContext.credentialTombstoneRefs) ||
    !validCredentialTombstoneRefs(credentialContext.otherModeCredentialTombstoneRefs) ||
    new Set(credentialContext.credentialTombstoneRefs).size !==
      credentialContext.credentialTombstoneRefs.length ||
    new Set(credentialContext.otherModeCredentialTombstoneRefs).size !==
      credentialContext.otherModeCredentialTombstoneRefs.length ||
    ((method !== 'manual' || enteredCode) &&
      (!credentialContext.credentialTombstoneRefs.length ||
        !credentialContext.otherModeCredentialTombstoneRefs.length)) ||
    (!!out.card && (!evaluatedSnapshot || out.card.passId !== evaluatedSnapshot.pass.id)) ||
    (evaluatedSnapshot !== null &&
      (!validCredentialTombstoneRefs(evaluatedSnapshot.credentialTombstoneRefs) ||
        !validCredentialTombstoneRefs(evaluatedSnapshot.otherModeCredentialTombstoneRefs) ||
        evaluatedSnapshot.credentialKeysetCommitment !== keyset ||
        evaluatedSnapshot.credentialTombstoneRefs.length !==
          credentialContext.credentialTombstoneRefs.length ||
        evaluatedSnapshot.credentialTombstoneRefs.some(
          (ref, index) => ref !== credentialContext.credentialTombstoneRefs[index],
        ) ||
        evaluatedSnapshot.otherModeCredentialTombstoneRefs.length !==
          credentialContext.otherModeCredentialTombstoneRefs.length ||
        evaluatedSnapshot.otherModeCredentialTombstoneRefs.some(
          (ref, index) => ref !== credentialContext.otherModeCredentialTombstoneRefs[index],
        )))
  )
    return;
  const keyEnv = captureCredentialKeyEnv(ctx.env);
  const sourceCredentialContext: CredentialTombstoneSnapshot = {
    credentialKeysetCommitment: keyset,
    credentialTombstoneRefs: [...credentialContext.credentialTombstoneRefs],
    otherModeCredentialTombstoneRefs: [...credentialContext.otherModeCredentialTombstoneRefs],
  };
  // Preserve authority before yielding; raw scanner CSRF must never enter the clone.
  const source = cloneObservedScanActor(actor);
  source.credentialKeysetCommitment = keyset;
  const db = ctx.env.DB;
  const hub = scanHub(ctx, source.orgId, source.mode);
  const captured =
    evaluatedSnapshot &&
    evaluatedSnapshot.pass.orgId === actor.orgId &&
    evaluatedSnapshot.pass.mode === actor.mode &&
    validCredentialTombstoneRefs(evaluatedSnapshot.credentialTombstoneRefs) &&
    validCredentialTombstoneRefs(evaluatedSnapshot.otherModeCredentialTombstoneRefs) &&
    ((method === 'manual' && !enteredCode) ||
      evaluatedSnapshot.credentialTombstoneRefs.length > 0) &&
    (!out.card || out.card.passId === evaluatedSnapshot.pass.id) &&
    evaluatedSnapshot.orgRevision !== null &&
    Number.isSafeInteger(evaluatedSnapshot.orgRevision) &&
    evaluatedSnapshot.orgRevision >= 0 &&
    evaluatedSnapshot.templateRevision !== null &&
    Number.isSafeInteger(evaluatedSnapshot.templateRevision) &&
    evaluatedSnapshot.templateRevision >= 0 &&
    evaluatedSnapshot.identityRevision !== null &&
    Number.isSafeInteger(evaluatedSnapshot.identityRevision) &&
    evaluatedSnapshot.identityRevision > 0 &&
    evaluatedSnapshot.activeTemplateVersion &&
    ((evaluatedSnapshot.pass.releaseId === null &&
      evaluatedSnapshot.activeTemplateVersion === evaluatedSnapshot.pass.templateVersion &&
      evaluatedSnapshot.activeReleaseId === null &&
      evaluatedSnapshot.activeReleaseGeneration === null &&
      evaluatedSnapshot.activeReleaseVersion === null &&
      evaluatedSnapshot.activeReleaseCandidateHash === null) ||
      (!!evaluatedSnapshot.activeReleaseId &&
        evaluatedSnapshot.activeReleaseGeneration !== null &&
        Number.isSafeInteger(evaluatedSnapshot.activeReleaseGeneration) &&
        evaluatedSnapshot.activeReleaseGeneration >= 0 &&
        !!evaluatedSnapshot.activeReleaseVersion &&
        evaluatedSnapshot.activeTemplateVersion === evaluatedSnapshot.activeReleaseVersion &&
        (evaluatedSnapshot.pass.templateVersion === evaluatedSnapshot.activeReleaseVersion ||
          evaluatedSnapshot.displayTemplateVersion === evaluatedSnapshot.activeReleaseVersion) &&
        typeof evaluatedSnapshot.activeReleaseCandidateHash === 'string' &&
        /^[a-f0-9]{64}$/.test(evaluatedSnapshot.activeReleaseCandidateHash)))
      ? {
          passId: evaluatedSnapshot.pass.id,
          passSnapshot: livePassSnapshot(keyEnv, evaluatedSnapshot),
        }
      : null;
  // A supplied pass must remain bound to the evaluated snapshot. Never downgrade malformed
  // or incomplete pass authority to a passless event.
  if (evaluatedSnapshot && !captured) return;
  const row: ScanLiveRow = {
    id: ctx.ids.token(16),
    at: ctx.clock.now(),
    scannerId: actor.scanner.id,
    scannerName: actor.name,
    passId: captured?.passId ?? null,
    holder: null,
    photoUrl: null,
    kind: undo ? 'undo' : out.kind,
    direction: out.checkIn?.direction ?? (out.kind === 'ok' ? 'in' : null),
    label: undo
      ? 'Undone'
      : out.kind === 'ok'
        ? out.checkIn?.direction === 'out'
          ? 'Checked out'
          : 'Checked in'
        : out.kind === 'ready'
          ? 'Choose an action'
          : out.kind === 'heads_up'
            ? 'Check required'
            : 'Not accepted',
    presented: method !== 'manual' || enteredCode,
  };
  ctx.waitUntil(
    (async () => {
      const [capturedKeyset, passSnapshot] = await Promise.all([
        credentialRefKeysetCommitment(keyEnv),
        captured ? captured.passSnapshot : Promise.resolve(null),
      ]);
      if (captured && !passSnapshot?.passCommitment) return;
      if (!(await safeEqual(capturedKeyset, keyset))) return;
      if (!(await liveCredentialKeyset(db, keyset))) return;
      const sourceProof = await sealLiveSourceProof(keyEnv, {
        credentialContext: sourceCredentialContext,
        actor: source,
        eventId: row.id,
        passId: row.passId,
        passSnapshot,
        at: row.at,
      });
      const accepted = await hub.publish({
        orgId: source.orgId,
        mode: source.mode,
        row: { ...row, sourceProof },
      });
      if (!accepted) throw new Error('SCAN_LIVE_PUBLISH_REJECTED');
    })().catch(() => {
      ctx.log.error('scan.live_publish_failed', {
        orgId: source.orgId,
        code: 'SCAN_LIVE_PUBLISH_FAILED',
      });
    }),
  );
}

/** A failed kick is retried and reported; the receiver also checks rows before any delivery. */
export async function kickScreen(ctx: ServiceContext, orgId: string, mode: string, id: string) {
  try {
    const closed = await scanHub(ctx, orgId, mode).kick(id);
    ctx.log.info('scan.live_kicked', { orgId, scannerId: id, closed });
  } catch {
    ctx.log.warn('scan.live_kick_retry', { orgId, code: 'SCAN_LIVE_KICK_RETRY' });
    await scanHub(ctx, orgId, mode).kick(id);
  }
}
