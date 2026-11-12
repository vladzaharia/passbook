import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, PassStyle } from '../../../passkit/types.ts';
import { PASS_STYLES } from '../../../passkit/types.ts';
import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import { type ResolvedScanManifest, scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import type { Pass } from '../passes/repo-map.ts';
import { policyAction } from './admission.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { visibleIdentity, visibleSource } from './card-semantics.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { scannerPassActive } from './member-photo.ts';
import {
  type Candidate,
  hasScanPolicy,
  type ReleaseSnapshot,
  type WalletSnapshot,
} from './repo-lookup.ts';
import { candidateWallet, matchesEvent, type TemplateRef } from './resolve-candidates.ts';
import { currentActions } from './resolve-policy.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

export interface Found extends ReleaseSnapshot, WalletSnapshot, CredentialTombstoneSnapshot {
  pass: Pass;
  /** Exact organization and template policy revisions observed with the pass. */
  orgRevision: number | null;
  templateRevision: number | null;
  /** Original candidate for internal live-display authorization, never projected. */
  liveCandidate?: Candidate;
  passJson: PassJson;
  connectionGeneration: number | null;
  template: ResolvedTemplate;
  /** Current approved revision, or the pinned revision for an eligible pre-release pass. */
  activeVersion: string;
  /** Compatible display version observed with the original candidate. */
  displayTemplateVersion: string | null;
  /** The current source/role policy, even when its display cannot be used for this pass. */
  activePolicy: ResolvedTemplate;
  /** Effective display policy: active only when the build keys match. */
  activeTemplate: ResolvedTemplate;
  scan: ResolvedScanManifest;
  ref: TemplateRef;
  checkInRules?: CheckInPolicy;
  admission?: AdmissionPlan;
  /** Internal event admission captured with action reads when no public check-in policy is set. */
  eventAdmission?: AdmissionPlan;
  eventAdmissionReason?: ScanReason | null;
}

/** Everything a stop step knows: the pass and template only when a step got far enough to find them. */
export interface Stop
  extends Partial<ReleaseSnapshot>,
    Partial<WalletSnapshot>,
    Partial<CredentialTombstoneSnapshot> {
  stop: true;
  kind: 'refused' | 'heads_up';
  reason: ScanReason;
  pass: Pass | null;
  ref: TemplateRef | null;
  /** The time the copy names: when it opens, ended, was removed or voided. */
  at: number | null;
  flags: string[];
  found: Found | null;
  /** Internal ledger linkage for an inactive pass; never an output identity. */
  auditPassId?: string;
  /** Original inactive candidate for internal atomic output authorization only. */
  auditCandidate?: Candidate;
  auditPassSnapshot?: Pick<
    Pass,
    | 'orgId'
    | 'mode'
    | 'identityId'
    | 'serial'
    | 'templateId'
    | 'templateVersion'
    | 'releaseId'
    | 'version'
    | 'revision'
    | 'linkGeneration'
    | 'credentialGeneration'
    | 'lifecycleGeneration'
    | 'imageGeneration'
    | 'status'
    | 'removedAt'
    | 'deletedAt'
    | 'testDataQuarantined'
    | 'connectionId'
  > &
    ReleaseSnapshot &
    WalletSnapshot &
    CredentialTombstoneSnapshot & {
      connectionGeneration: number | null;
      activeTemplateVersion: string | null;
      orgRevision: number | null;
      templateRevision: number | null;
    };
  connectionGeneration?: number | null;
  activeTemplateVersion?: string | null;
  orgRevision?: number | null;
  templateRevision?: number | null;
  /** Internal only: no commit without a current release and compatible pass build. */
  stale?: true;
  hard?: boolean;
}
export type Evaluated = { stop: false; found: Found } | Stop;

export const styleOf = (passJson: PassJson): string =>
  PASS_STYLES.find((s: PassStyle) => s in passJson) ?? 'generic';

/** Scope of a candidate for scanner assets and live recipients; database authority is rechecked separately. */
export function candidateInScope(actor: ScanActor, candidate: Candidate): boolean {
  const scanner = actor.scanner;
  if (
    actor.invalidScannerScope ||
    (actor.scanningSession && actor.scanningSession.status !== 'active') ||
    (actor.principal === 'scanner' && !scanner) ||
    (actor.scanningSession && !scanner) ||
    scanner?.deviceRole === 'customer' ||
    (actor.role === null && scanner?.deviceRole !== 'monitor') ||
    (scanner &&
      (scanner.orgId !== actor.orgId ||
        scanner.mode !== actor.mode ||
        scanner.revokedAt !== null)) ||
    candidate.pass.orgId !== actor.orgId ||
    candidate.pass.mode !== actor.mode ||
    candidate.pass.testDataQuarantined ||
    (scanner?.eventId && !actor.scanningSession && actor.event?.id !== scanner.eventId) ||
    (actor.event && actor.templateIds.length === 0)
  )
    return false;
  if (actor.templateIds.length > 0 && !actor.templateIds.includes(candidate.pass.templateId))
    return false;
  if (actor.templateIds.length === 0 && actor.scanningSession && scanner?.deviceRole === 'monitor')
    return false;
  if (
    actor.templateIds.length === 0 &&
    scanner?.deviceRole === 'scan' &&
    !actor.settings.acceptAllTemplates
  )
    return false;
  return matchesEvent(actor, candidate.pass);
}

export async function foundOf(
  ctx: ServiceContext,
  c: Candidate,
  actor?: ScanActor,
  options?: {
    /** Only templates verified against the original candidate's live snapshot. */
    verifiedTemplates: { pinned: ResolvedTemplate; active: ResolvedTemplate };
  },
): Promise<Found | null> {
  if (c.pass.connectionId !== null && c.connectionGeneration === null) return null;
  if (c.orgRevision == null || c.templateRevision == null) return null;
  if (!hasScanPolicy(c) || !c.activeTemplateVersion) return null;
  const passJson = candidateWallet(c);
  if (!passJson) return null;
  if (actor && (actor.role === null || !candidateInScope(actor, c))) return null;
  const verified = options?.verifiedTemplates ?? resolveCandidateReadTemplates(c);
  if (
    !verified ||
    verified.pinned.id !== c.pass.templateId ||
    verified.pinned.version !== c.pass.templateVersion ||
    verified.active.id !== c.pass.templateId ||
    verified.active.version !== c.activeTemplateVersion ||
    (verified.pinned.orgId !== null && verified.pinned.orgId !== c.pass.orgId) ||
    (verified.active.orgId !== null && verified.active.orgId !== c.pass.orgId)
  )
    return null;
  try {
    const template = verified.pinned;
    const activePolicy = verified.active;
    const activeTemplate =
      c.displayTemplateVersion === c.activeTemplateVersion ? activePolicy : template;
    if (!scannerPassActive(c, passJson, ctx.clock.now())) return null;
    const rules = c.checkInRules ?? {};
    const scan = scanOf(template.manifest);
    const found: Found = {
      pass: c.pass,
      orgRevision: c.orgRevision,
      templateRevision: c.templateRevision,
      activeReleaseId: c.activeReleaseId,
      activeReleaseGeneration: c.activeReleaseGeneration,
      activeReleaseVersion: c.activeReleaseVersion,
      activeReleaseCandidateHash: c.activeReleaseCandidateHash,
      liveCandidate: c,
      connectionGeneration: c.connectionGeneration,
      passJson,
      passPersonalizationSnapshot: c.passPersonalizationSnapshot,
      fieldSourcesSnapshot: c.fieldSourcesSnapshot,
      assetPhoto: c.assetPhoto,
      passJsonSnapshot: c.passJsonSnapshot,
      walletVersion: c.walletVersion,
      walletTemplateVersion: c.walletTemplateVersion,
      versionPersonalization: c.versionPersonalization,
      identityPassTypeIdentifier: c.identityPassTypeIdentifier,
      identityTeamIdentifier: c.identityTeamIdentifier,
      identityRevision: c.identityRevision,
      transferPending: c.transferPending,
      credentialKeysetCommitment: c.credentialKeysetCommitment,
      credentialTombstoneRefs: c.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: c.otherModeCredentialTombstoneRefs,
      template,
      activeVersion: c.activeTemplateVersion,
      displayTemplateVersion: c.displayTemplateVersion,
      activePolicy,
      activeTemplate,
      scan: {
        ...scan,
        display: scanOf(activeTemplate.manifest).display,
        actions: currentActions(scan.actions, scanOf(activePolicy.manifest).actions).map((action) =>
          policyAction(action, {
            ...rules,
            mode: rules.mode ?? actor?.settings.checkIn?.mode,
          }),
        ),
      },
      checkInRules: rules,
      ref: { name: template.manifest.name, style: styleOf(passJson) },
    };
    if (actor) {
      const identity = visibleIdentity(found, actor);
      found.pass = {
        ...found.pass,
        displayTitle: identity.title,
        displaySubtitle: identity.subtitle,
      };
    }
    return found;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** The flags that are on for this pass (SA 4.1); a stop flag holds the check-in until confirmed. */
export function activeFlags(found: Found, actor?: ScanActor): { label: string; stop: boolean }[] {
  const privacy = actor ? cardPrivacy(found, actor) : null;
  return (found.scan.flags ?? []).flatMap((f) => {
    if (
      actor &&
      privacy &&
      (!visibleSource(found, actor, f.input, privacy) || !privacy.safe(f.label))
    )
      return [];
    const value = found.pass.personalization[f.input];
    const on = f.equals
      ? f.equals.includes(String(value))
      : value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
    return on ? [{ label: f.label, stop: f.stop === true }] : [];
  });
}
