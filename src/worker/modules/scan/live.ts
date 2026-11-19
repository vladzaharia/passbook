import { parseIsoDate } from '../../../passkit/schema/util.ts';
import type { ScanOutcome, ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { epochsMissing } from './authority-capture.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { usedRelease } from './effective-release.ts';
import { sourceActor } from './event-safe-projection-policy.ts';
import { pinKeyset } from './keyset-pin.ts';
import type { LiveAttachment } from './live-auth.ts';
import type { LiveRingRow } from './live-ring.ts';
import { photoPolicyForResolved, scannerCandidateAllowed } from './member-photo.ts';
import { isOverridable } from './outcome.ts';
import { scanIdentity } from './projection-privacy.ts';
import { CREDENTIAL_REF_PREFIX } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';

/** The live row id of a scan: stable, and never the scan's own id. */
export const liveRowId = async (scanId: string): Promise<string> =>
  (await sha256Hex(`live-row:${scanId}`)).slice(0, 32);

export const scanHub = (ctx: ServiceContext, orgId: string, mode: string) =>
  ctx.env.SCAN_HUB.getByName(`${orgId}:${mode}`);

/**
 * The sealed attachment for a socket. A screen (`customer`, `monitor`) reads rows; `device` is the control
 * socket of a scan-role device (paired scanner, never a till or a console): it carries `control`, `enroll`
 * and `resolved` and no rows.
 */
export function liveAttachment(
  ctx: ServiceContext,
  actor: ScanActor,
  as: 'screen' | 'device' = 'screen',
): LiveAttachment {
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
  let role: LiveAttachment['role'];
  if (as === 'device') {
    if (row.deviceRole !== 'scan' || actor.principal !== 'scanner')
      throw new ForbiddenError('Only a scanner opens a device connection.', 'DEVICE_REQUIRED');
    role = 'device';
  } else {
    if (row.deviceRole === 'scan')
      throw new ForbiddenError('Choose a screen view in Scanning.', 'SCREEN_REQUIRED');
    role = row.deviceRole;
  }
  const epochs = scanEpochsOf(actor);
  if (!epochs) throw epochsMissing();
  const capturedActor = cloneObservedScanActor(actor);
  // A watch edit must not outlive the socket's token: the cover is re-read on each request.
  delete capturedActor.watchCover;
  // A device socket outlives staff sign-in and sign-out: it is bound to the device, not to a person.
  if (as === 'device') {
    capturedActor.staff = null;
    capturedActor.role = null;
  }
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
    role,
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

const ROLES: readonly ScanRole[] = ['door', 'desk', 'manager'];

/**
 * The pass facts a live row discloses, taken from the candidate the scan evaluated: the holder name
 * (as the source screen showed it), the roles that would read the same name, the roles a photo is
 * shown to, and the generations and release a render re-checks. Null when the pass cannot be
 * evaluated for the source (the row is then published as a redacted row).
 */
async function passDetail(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  keyset: string,
): Promise<
  | (Pick<
      LiveRingRow,
      'templateId' | 'gen' | 'release' | 'validUntil' | 'holderRoles' | 'photoRoles'
    > & { holder: string | null })
  | null
> {
  const { pass } = candidate;
  const release = usedRelease(candidate.templateSnapshot?.raw);
  const found = release === false ? null : await foundOf(ctx, candidate);
  const now = ctx.clock.now();
  if (
    !found ||
    release === false ||
    candidate.credentialKeysetCommitment !== keyset ||
    pass.orgId !== actor.orgId ||
    pass.mode !== actor.mode ||
    !scannerCandidateAllowed(actor, candidate, found.passJson, now)
  )
    return null;
  const title = scanIdentity(found, actor).title;
  const holderRoles = title
    ? ROLES.filter((r) => scanIdentity(found, sourceActor(actor, r)).title === title)
    : [];
  const photoRoles = ROLES.filter((r) =>
    photoPolicyForResolved(
      sourceActor(actor, r),
      candidate,
      found.template,
      found.activePolicy,
      now,
    ),
  );
  return {
    templateId: pass.templateId,
    gen: {
      credential: pass.credentialGeneration,
      lifecycle: pass.lifecycleGeneration,
      image: pass.imageGeneration,
    },
    release: release === null ? null : release[0],
    validUntil: parseIsoDate(found.passJson.expirationDate) ?? null,
    holder: title ? title.slice(0, 40) : null,
    holderRoles,
    photoRoles,
  };
}

/** The ring entry for a committed scan of `candidate` (null: no pass); null when the pass cannot be shown. */
export async function liveRingRow(
  ctx: ServiceContext,
  source: ScanActor,
  base: ScanLiveRow,
  candidate: Candidate | null,
  scanId: string | null,
  /** The full keyed refs of the credential the scan presented. */
  credentialRefs: readonly string[] = [],
  /** The checked zones and their ancestors, and the doc-named customer body, when the scan has them. */
  extra: Pick<LiveRingRow, 'zoneIds' | 'customer' | 'overridable'> = {},
): Promise<LiveRingRow | null> {
  const detail = candidate ? await passDetail(ctx, source, candidate, await pinKeyset(ctx)) : null;
  if (candidate && !detail) return null;
  const staff = source.staff ? scanEpochsOf(source)?.staff : undefined;
  return {
    row: detail && candidate ? { ...base, passId: candidate.pass.id, holder: detail.holder } : base,
    scanId,
    templateId: detail?.templateId ?? null,
    gen: detail?.gen ?? null,
    release: detail?.release ?? null,
    validUntil: detail?.validUntil ?? null,
    sourceRole: source.role,
    sourceStaff: staff ? { id: staff.id, authEpoch: staff.auth } : null,
    refPrefixes: detail ? credentialRefs.map((ref) => ref.slice(0, CREDENTIAL_REF_PREFIX)) : [],
    holderRoles: detail?.holderRoles ?? [],
    photoRoles: detail?.photoRoles ?? [],
    sessionId: source.scanningSession?.id ?? null,
    eventId: source.event?.id ?? null,
    zoneIds: extra.zoneIds ?? [],
    customer: detail ? (extra.customer ?? null) : null,
    ...(extra.overridable ? { overridable: true } : {}),
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
  /** A desk override's row: what it overrides, who did it, which customer body it replaces. */
  extra: Partial<ScanLiveRow> = {},
) {
  if (!actor.scanner || (!actor.scanningSession && !actor.scanner.hasScreens) || out.replay) return;
  // A supplied pass must stay bound to the outcome; never downgrade it to a passless event.
  if (out.card && (!evaluatedSnapshot || out.card.passId !== evaluatedSnapshot.pass.id)) return;
  const source = cloneObservedScanActor(actor);
  const scanner = actor.scanner;
  const hub = scanHub(ctx, source.orgId, source.mode);
  const base: ScanLiveRow = {
    id: ctx.ids.token(16),
    at: ctx.clock.now(),
    scannerId: scanner.id,
    scannerName: actor.name,
    passId: null,
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
    ...extra,
  };
  ctx.waitUntil(
    (async () => {
      // Derived from the scan so a later override can name this row (`replaces`) without a scan id on the wire.
      const row = out.scanId ? { ...base, id: await liveRowId(out.scanId) } : base;
      const entry = await liveRingRow(
        ctx,
        source,
        row,
        evaluatedSnapshot,
        out.scanId,
        credentialContext?.credentialTombstoneRefs ?? [],
        {
          overridable:
            !undo &&
            out.scanId !== null &&
            (out.kind === 'heads_up' || out.kind === 'refused') &&
            isOverridable(out.reason),
        },
      );
      // An evaluated pass that cannot be shown is withheld, not published as a refusal.
      if (!entry) return;
      if (
        !(await hub.publish({
          orgId: source.orgId,
          mode: source.mode,
          row: entry,
          now: ctx.clock.now(),
        }))
      )
        throw new Error('SCAN_LIVE_PUBLISH_REJECTED');
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
