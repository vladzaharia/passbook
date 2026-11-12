import { parseIsoDate } from '../../../passkit/schema/util.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson } from '../../../passkit/types.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { takePhotoGrantToken } from './asset-sidecar.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import { assetBaseUrl, preparePhotoGrant } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { passSnapshotCurrentStrict } from './repo-pass-authority.ts';
import { matchesEvent } from './resolve-candidates.ts';
import { ROLE_RANK } from './rules.ts';
import { walletIdentityMatches } from './wallet-snapshot.ts';

/** Scanner projections must not disclose an inactive pass or a disabled connection. */
export function scannerPassActive(candidate: Candidate, passJson: PassJson, now: number): boolean {
  const pass = candidate.pass;
  if (candidate.transferPending !== false) return false;
  if (!Number.isSafeInteger(pass.credentialGeneration) || pass.credentialGeneration <= 0)
    return false;
  if (!Number.isSafeInteger(pass.lifecycleGeneration) || pass.lifecycleGeneration < 0) return false;
  if (
    typeof candidate.identityRevision !== 'number' ||
    !Number.isSafeInteger(candidate.identityRevision) ||
    candidate.identityRevision <= 0
  )
    return false;
  if (!walletIdentityMatches(candidate, passJson)) return false;
  const expiry = parseIsoDate(passJson.expirationDate);
  if (passJson.expirationDate !== undefined && expiry === undefined) return false;
  return (
    !pass.testDataQuarantined &&
    (pass.connectionId === null
      ? candidate.connectionGeneration === null
      : typeof candidate.connectionGeneration === 'number' &&
        Number.isSafeInteger(candidate.connectionGeneration) &&
        candidate.connectionGeneration >= 0) &&
    pass.deletedAt === null &&
    pass.removedAt === null &&
    pass.status === 'active' &&
    (passJson.voided === undefined || typeof passJson.voided === 'boolean') &&
    passJson.voided !== true &&
    (expiry === undefined || expiry >= now)
  );
}

/**
 * A legacy pass may carry an all-null release sentinel; the repository fence proves that no
 * effective approved head exists. Otherwise authorization requires a complete scoped release.
 * A pass used under its own release while the head is on another build (null display version)
 * is allowed, as on the card; `photoPolicyForResolved` still applies the head's policy.
 */
export function scannerReleaseAllowed(candidate: Candidate): boolean {
  if (
    candidate.activeReleaseId === null &&
    candidate.activeReleaseGeneration === null &&
    candidate.activeReleaseVersion === null &&
    candidate.activeReleaseCandidateHash === null
  )
    return (
      candidate.pass.releaseId === null &&
      candidate.activeTemplateVersion === candidate.pass.templateVersion &&
      candidate.displayTemplateVersion === candidate.pass.templateVersion
    );
  return (
    (candidate.pass.releaseId === null || !!candidate.pass.releaseId) &&
    !!candidate.activeReleaseId &&
    typeof candidate.activeReleaseGeneration === 'number' &&
    Number.isSafeInteger(candidate.activeReleaseGeneration) &&
    candidate.activeReleaseGeneration > 0 &&
    !!candidate.activeReleaseVersion &&
    candidate.activeReleaseVersion === candidate.activeTemplateVersion &&
    (candidate.pass.templateVersion === candidate.activeReleaseVersion ||
      candidate.displayTemplateVersion === candidate.activeReleaseVersion ||
      candidate.displayTemplateVersion === null) &&
    !!candidate.activeReleaseCandidateHash &&
    /^[a-f0-9]{64}$/.test(candidate.activeReleaseCandidateHash)
  );
}

/** Scope and activity apply to identity as well as photo projections. */
export function scannerCandidateAllowed(
  actor: ScanActor,
  candidate: Candidate,
  passJson: PassJson,
  now: number,
): boolean {
  if (actor.scanningSession && actor.scanningSession.status !== 'active') return false;
  if ('invalidScannerScope' in actor && actor.invalidScannerScope) return false;
  if (candidate.pass.orgId !== actor.orgId || candidate.pass.mode !== actor.mode) return false;
  if (actor.scanner?.eventId && !actor.scanningSession && !actor.event) return false;
  if (actor.event && (actor.event.mode !== actor.mode || actor.event.archivedAt !== null))
    return false;
  const scoped =
    actor.scanner?.deviceRole === 'scan' ||
    !!actor.scanningSession ||
    !!actor.event ||
    actor.templateIds.length > 0;
  if (
    scoped &&
    (actor.templateIds.length > 0
      ? !actor.templateIds.includes(candidate.pass.templateId)
      : actor.settings.acceptAllTemplates !== true)
  )
    return false;
  if (!matchesEvent(actor, candidate.pass)) return false;
  return scannerPassActive(candidate, passJson, now);
}

function photoRole(
  actor: ScanActor,
  candidate: Candidate,
  now: number,
  sourceRole?: ScanRole | null,
): ScanRole | null {
  const role =
    actor.role ?? (actor.scanner?.deviceRole === 'monitor' ? (sourceRole ?? null) : null);
  if (actor.settings.showPhoto === false || role === null) return null;
  if (actor.scanner?.deviceRole === 'customer') return null;
  if (!candidate.passJsonSnapshot) return null;
  let passJson: PassJson;
  try {
    passJson = JSON.parse(candidate.passJsonSnapshot) as PassJson;
  } catch {
    return null;
  }
  return scannerCandidateAllowed(actor, candidate, passJson, now) ? role : null;
}

/** Evaluate both original pinned and current approved policies without database reads. */
export function photoPolicyForResolved(
  actor: ScanActor,
  candidate: Candidate,
  pinned: Pick<ResolvedTemplate, 'id' | 'version' | 'manifest'>,
  active: Pick<ResolvedTemplate, 'id' | 'version' | 'manifest'>,
  now: number,
  sourceRole?: ScanRole | null,
): boolean {
  const policyVersion = candidate.activeReleaseVersion ?? candidate.pass.templateVersion;
  if (
    !candidate.hasPhoto ||
    !candidate.assetPhoto ||
    !Number.isSafeInteger(candidate.pass.imageGeneration) ||
    candidate.pass.imageGeneration < 0 ||
    !candidate.activeTemplateVersion ||
    typeof candidate.orgRevision !== 'number' ||
    typeof candidate.templateRevision !== 'number' ||
    !scannerReleaseAllowed(candidate) ||
    pinned.id !== candidate.pass.templateId ||
    pinned.version !== candidate.pass.templateVersion ||
    active.id !== candidate.pass.templateId ||
    active.version !== policyVersion
  )
    return false;
  const role = photoRole(actor, candidate, now, sourceRole);
  if (!role) return false;
  const pinnedRole = pinned.manifest.scan?.display?.photo?.minRole ?? 'door';
  const activeRole = active.manifest.scan?.display?.photo?.minRole ?? 'door';
  return ROLE_RANK[role] >= ROLE_RANK[pinnedRole] && ROLE_RANK[role] >= ROLE_RANK[activeRole];
}

/** Evaluate the pinned and current photo policies against the captured candidate. */
export async function photoPolicyAllowed(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  pinned?: ResolvedTemplate,
  currentTemplate?: ResolvedTemplate,
  sourceRole?: ScanRole | null,
): Promise<boolean> {
  if (
    !candidate.hasPhoto ||
    !candidate.activeTemplateVersion ||
    typeof candidate.orgRevision !== 'number' ||
    typeof candidate.templateRevision !== 'number' ||
    !scannerReleaseAllowed(candidate)
  )
    return false;
  try {
    const template =
      (pinned?.id === candidate.pass.templateId && pinned.version === candidate.pass.templateVersion
        ? pinned
        : undefined) ??
      (await resolveTemplate(
        ctx,
        actor.orgId,
        candidate.pass.templateId,
        candidate.pass.templateVersion,
      ));
    const policyVersion = candidate.activeReleaseVersion ?? candidate.pass.templateVersion;
    const active =
      policyVersion === template.version
        ? template
        : currentTemplate?.id === candidate.pass.templateId &&
            currentTemplate.version === policyVersion
          ? currentTemplate
          : await resolveTemplate(ctx, actor.orgId, candidate.pass.templateId, policyVersion);
    return photoPolicyForResolved(actor, candidate, template, active, ctx.clock.now(), sourceRole);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** A current photo restriction applies even when the active template cannot rebuild this pass. */
export async function canShowPhotoForCandidate(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  pinned?: ResolvedTemplate,
  currentTemplate?: ResolvedTemplate,
  sourceRole?: ScanRole | null,
): Promise<boolean> {
  if (!(await photoPolicyAllowed(ctx, actor, candidate, pinned, currentTemplate, sourceRole)))
    return false;
  return passSnapshotCurrentStrict(
    ctx.env.DB,
    candidate.pass,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
    candidate.orgRevision,
    candidate.templateRevision,
    ctx.clock.now(),
    candidate,
  );
}

export async function memberPhotoCandidate(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  sourceRole?: ScanRole | null,
): Promise<Candidate | null> {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const keyset = await requireCredentialRefKeyset(pinned.env.DB, pinned.env);
  const candidate = await candidateById(pinned.env.DB, actor.orgId, passId);
  return candidate &&
    candidate.credentialKeysetCommitment === keyset &&
    (await canShowPhotoForCandidate(ctx, actor, candidate, undefined, undefined, sourceRole))
    ? candidate
    : null;
}

export async function canShowMemberPhoto(ctx: ServiceContext, actor: ScanActor, passId: string) {
  return (await memberPhotoCandidate(ctx, actor, passId)) !== null;
}

/** Internal until the guarded grant insert has been confirmed. */
export interface PreparedPhotoGrant {
  grant: PreparedAssetGrant;
}

export async function knownPhotoUrl(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  template: ResolvedTemplate,
  currentTemplate?: ResolvedTemplate,
): Promise<PreparedPhotoGrant | null> {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  if (!(await photoPolicyAllowed(ctx, actor, candidate, template, currentTemplate))) return null;
  try {
    const grant = await preparePhotoGrant(
      pinned,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
    );
    return grant ? { grant } : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Construct the URL only after the exact grant's atomic insert is confirmed. */
export function confirmedPhotoUrl(
  actor: ScanActor,
  passId: string,
  grant: PreparedAssetGrant,
  results: readonly D1Result[] | undefined,
): string | null {
  const token = takePhotoGrantToken(actor, passId, grant, results);
  return token ? photoUrlFor(actor, passId, token) : null;
}

function photoUrlFor(actor: ScanActor, passId: string, grant: string): string {
  const params = new URLSearchParams({ g: grant });
  if (actor.principal === 'admin') {
    params.set('orgId', actor.orgId);
    params.set('timeZone', actor.timeZone);
    if (actor.scanner) params.set('setupId', actor.scanner.id);
    else {
      if (actor.event) params.set('eventId', actor.event.id);
      if (actor.templateIds.length) params.set('templateIds', actor.templateIds.join(','));
    }
  }
  return `${assetBaseUrl(passId)}member.png?${params}`;
}
