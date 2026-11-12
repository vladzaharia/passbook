import { derivedHmacKey } from '../../platform/crypto.ts';
import { toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import type { AssetSessionSnapshot } from './asset-types.ts';
import type { AssetGrantCsrfResults, AssetGrantGuardInput } from './repo-asset-lineage.ts';
import { matchesEvent } from './resolve-candidates.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Clone only original internal fields; no raw scanner CSRF enters a structured clone. */
export function captureActor(actor: ScanActor): ScanActor {
  return cloneObservedScanActor(actor);
}

/** Copy authority before asynchronous work without cloning raw credential material. */
export function captureAssetGrantGuard(input: AssetGrantGuardInput): AssetGrantGuardInput {
  return {
    passId: input.passId,
    snapshotProof: input.snapshotProof,
    actor: captureActor(input.actor),
    source: input.source
      ? {
          sourceId: input.source.sourceId,
          eventId: input.source.eventId,
          actor: captureActor(input.source.actor),
        }
      : undefined,
    recipientSession: input.recipientSession ? { ...input.recipientSession } : null,
    sourceSession: input.sourceSession ? { ...input.sourceSession } : null,
    connectionGeneration: input.connectionGeneration,
    activeVersion: input.activeVersion,
    credentialTombstoneRefs: [...input.credentialTombstoneRefs],
    requirePhoto: input.requirePhoto,
    purpose: input.purpose,
    ...(input.storedGrant ? { storedGrant: { ...input.storedGrant } } : {}),
  };
}

/** Retain supplied CSRF scalars only in a request-local copy, never a structured clone. */
export function captureAssetGrantCsrf(
  results: AssetGrantCsrfResults | undefined,
): AssetGrantCsrfResults | undefined {
  if (!results) return undefined;
  const snapshot = (value: ActorCsrfSnapshot | undefined): ActorCsrfSnapshot | undefined =>
    value && {
      session: value.session ? { ...value.session } : null,
      scanner: value.scanner ? { ...value.scanner } : null,
    };
  const result = (value: D1Result | undefined): D1Result | undefined => {
    if (value?.success !== true) return undefined;
    const row = value.results?.[0] as Record<string, unknown> | undefined;
    return { ...value, results: row ? [{ ...row }] : [] };
  };
  return {
    recipient: result(results.recipient),
    source: result(results.source),
    recipientSnapshot: snapshot(results.recipientSnapshot),
    sourceSnapshot: snapshot(results.sourceSnapshot),
  };
}

/** Only authority-defining scalars enter the MAC, not a serialized actor or a DTO. */
async function actorScope(
  ctx: ServiceContext,
  actor: ScanActor,
  session: AssetSessionSnapshot | null,
) {
  const scanner = actor.scanner;
  const staff = actor.staff;
  // Epochs, not timestamps: a rename moves `updated_at` but no authority (authority-epochs.md).
  const epochs = scanEpochsOf(actor);
  const adminEventTemplates = 'adminEventTemplates' in actor && actor.adminEventTemplates === true;
  const tenant = actor.tenantAuthority ?? null;
  const platformId = actor.platformSessionId ?? null;
  const tenantId = tenant?.sessionId ?? null;
  let platformIdProof: string | null = null;
  let tenantIdProof: string | null = null;
  if (platformId !== null || tenantId !== null) {
    const key = await derivedHmacKey(ctx.env, 'scan-asset-session-id');
    const signId = async (id: string | null) =>
      id === null
        ? null
        : toBase64Url(
            new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id))),
          );
    platformIdProof = await signId(platformId);
    tenantIdProof = tenantId === platformId ? platformIdProof : await signId(tenantId);
  }
  return [
    actor.principal,
    actor.orgId,
    actor.mode,
    actor.actorKey,
    actor.actor.type,
    actor.actor.id,
    actor.role,
    actor.terminal,
    actor.timeZone,
    adminEventTemplates,
    platformIdProof,
    [...actor.templateIds].sort(),
    tenant && [
      tenant.orgId,
      // Despite the name, the org's `access_revision` (`tenantAuthorityOf`): a rename keeps it.
      tenant.orgUpdatedAt,
      tenant.userId,
      tenantIdProof,
      tenant.membershipId,
      tenant.roles,
      tenant.capability,
      tenant.mode,
      tenant.sessionRoles,
      tenant.amr,
      tenant.sessionCreatedAt,
      tenant.sessionExpiresAt,
      tenant.sessionCsrfProof,
    ],
    scanner && [
      scanner.id,
      scanner.orgId,
      scanner.mode,
      scanner.kind,
      scanner.deviceRole,
      scanner.eventId,
      epochs?.scanner?.id === scanner.id ? epochs.scanner.credential : null,
      epochs?.scanner?.id === scanner.id ? epochs.scanner.config : null,
      scanner.settings,
      scanner.timeZone,
      scanner.tokenPrefix,
      scanner.tokenHash,
      actor.scannerCsrfProof,
      scanner.pairedAt,
      scanner.expiresAt,
      scanner.revokedAt,
      scanner.staffId,
      scanner.staffSince,
    ],
    staff && [staff.id, staff.role, epochs?.staff?.id === staff.id ? epochs.staff.auth : null],
    actor.event && [
      actor.event.id,
      actor.event.orgId,
      actor.event.mode,
      epochs?.events[actor.event.id] ?? null,
    ],
    actor.scanningSession && [
      actor.scanningSession.id,
      actor.scanningSession.status,
      epochs?.session?.id === actor.scanningSession.id ? epochs.session.config : null,
    ],
    session && [
      session.user_id,
      session.amr,
      session.roles,
      session.created_at,
      session.expires_at,
      session.membership_id,
      session.membership_roles,
    ],
  ];
}

export async function assetActorScope(ctx: ServiceContext, actor: ScanActor, pass: Pass) {
  if (actor.orgId !== pass.orgId || actor.mode !== pass.mode || !matchesEvent(actor, pass))
    return null;
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    if (
      authority?.kind !== 'session' ||
      !Array.isArray(authority.sessionRoles) ||
      authority.sessionRoles.length === 0 ||
      !authority.sessionRoles.every((role) => role === 'admin' || role === 'user') ||
      !['oidc', 'magic_link', 'breakglass'].includes(authority.amr) ||
      typeof authority.sessionCsrfProof !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(authority.sessionCsrfProof) ||
      !actor.platformSessionId ||
      actor.actor.type !== 'user'
    )
      return null;
  }
  if (
    actor.scanner &&
    (actor.scannerCsrfProof === undefined ||
      (actor.scannerCsrfProof !== null &&
        (typeof actor.scannerCsrfProof !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof))) ||
      (actor.principal === 'scanner' && !actor.terminal && actor.scannerCsrfProof === null))
  )
    return null;
  let session: AssetSessionSnapshot | null = null;
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    if (
      !authority ||
      authority.sessionId !== actor.platformSessionId ||
      authority.userId !== actor.actor.id ||
      !Array.isArray(authority.roles) ||
      !Number.isSafeInteger(authority.sessionCreatedAt) ||
      !Number.isSafeInteger(authority.sessionExpiresAt) ||
      authority.sessionExpiresAt <= authority.sessionCreatedAt
    )
      return null;
    // These values came from the authenticated actor. The final SQL rechecks the
    // same session, membership, role arrays, CSRF proof and immutable lifetime.
    session = {
      user_id: authority.userId,
      amr: authority.amr,
      roles: JSON.stringify(authority.sessionRoles),
      created_at: authority.sessionCreatedAt,
      expires_at: authority.sessionExpiresAt,
      membership_id: authority.membershipId,
      membership_roles: JSON.stringify(authority.roles),
    };
  }
  return { fields: await actorScope(ctx, actor, session), session };
}
