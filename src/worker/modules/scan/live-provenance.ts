import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  RoleSchema,
  TimestampSchema,
} from '../../../shared/contracts/common.ts';
import { OrgRolesSchema } from '../../../shared/contracts/org-membership.ts';
import { ScannerSettingsSchema, ScanRoleSchema } from '../../../shared/contracts/scan.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ScanActor } from './actor.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { livePassCommitment } from './live-pass-commitment.ts';
import { epochsSchema, eventSnapshot, scannerSnapshot } from './live-snapshot-schemas.ts';
import { openLiveSourceEnvelope, sealLiveSourceEnvelope } from './live-source-envelope.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import { type ScanAuthorityEpochs, scanEpochsOf, setScanEpochs } from './scan-epochs.ts';
import {
  captureObservedScanningSession,
  restoreObservedScanningSession,
} from './scanning-workspace-observation.ts';

/** This row is confined to the hub; the proof is never part of a live DTO or URL. */
export type InternalLiveRow = ScanLiveRow & { sourceProof: string };

export interface LivePassSnapshot {
  version: number;
  revision: number;
  linkGeneration: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
  imageGeneration: number;
  transferPending: boolean;
  /** Opaque input-authority refs stay encrypted and never appear in a live DTO or URL. */
  credentialTombstoneRefs: readonly string[];
  otherModeCredentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  passReleaseId: string | null;
  passCommitment: string | null;
  walletVersion: number | null;
  walletTemplateVersion: string | null;
  connectionGeneration: number | null;
  activeTemplateVersion: string | null;
  displayTemplateVersion: string | null;
  orgRevision: number | null;
  templateRevision: number | null;
  identityRevision: number | null;
  activeReleaseId: string | null;
  activeReleaseGeneration: number | null;
  activeReleaseVersion: string | null;
  activeReleaseCandidateHash: string | null;
}

/** Copy evaluated lineage and canonical authority bytes before the first await. */
export async function livePassSnapshot(
  env: object,
  candidate: Candidate,
): Promise<LivePassSnapshot> {
  if (
    !validCredentialTombstoneRefs(candidate.credentialTombstoneRefs) ||
    !validCredentialTombstoneRefs(candidate.otherModeCredentialTombstoneRefs) ||
    typeof candidate.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.credentialKeysetCommitment)
  )
    throw new Error('Invalid live credential evidence.');
  const snapshot: LivePassSnapshot = {
    version: candidate.pass.version,
    revision: candidate.pass.revision,
    linkGeneration: candidate.pass.linkGeneration,
    credentialGeneration: candidate.pass.credentialGeneration,
    lifecycleGeneration: candidate.pass.lifecycleGeneration,
    imageGeneration: candidate.pass.imageGeneration,
    transferPending: candidate.transferPending,
    credentialTombstoneRefs: [...candidate.credentialTombstoneRefs],
    otherModeCredentialTombstoneRefs: [...candidate.otherModeCredentialTombstoneRefs],
    credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    passReleaseId: candidate.pass.releaseId,
    passCommitment: null,
    walletVersion: candidate.walletVersion,
    walletTemplateVersion: candidate.walletTemplateVersion,
    connectionGeneration: candidate.connectionGeneration,
    activeTemplateVersion: candidate.activeTemplateVersion,
    displayTemplateVersion: candidate.displayTemplateVersion,
    orgRevision: candidate.orgRevision,
    templateRevision: candidate.templateRevision,
    identityRevision: candidate.identityRevision,
    activeReleaseId: candidate.activeReleaseId,
    activeReleaseGeneration: candidate.activeReleaseGeneration,
    activeReleaseVersion: candidate.activeReleaseVersion,
    activeReleaseCandidateHash: candidate.activeReleaseCandidateHash,
  };
  snapshot.passCommitment = await livePassCommitment(env, candidate);
  return snapshot;
}
export interface LiveSourceProof {
  actor: ScanActor;
  eventId: string;
  credentialContext: CredentialTombstoneSnapshot;
  passId: string | null;
  passSnapshot: LivePassSnapshot | null;
  at: number;
}

const revisionNumber = z.number().int().nonnegative();
/** Validate without projecting away the original actor's private authority fields. */
export const liveActorSchema = z.strictObject({
  principal: z.enum(['scanner', 'admin']),
  orgId: IdSchema,
  mode: ModeSchema,
  actorKey: z.string().min(1),
  actor: z.strictObject({ type: z.enum(['scanner', 'user']), id: IdSchema }),
  scanner: scannerSnapshot,
  event: eventSnapshot.nullable(),
  templateIds: z.array(IdSchema),
  adminEventTemplates: z.boolean().optional(),
  invalidScannerScope: z.boolean().optional(),
  scannerAssignment: z
    .strictObject({
      scannerId: IdSchema,
      orgId: IdSchema,
      mode: ModeSchema,
      eventId: IdSchema.nullable(),
      event: eventSnapshot.nullable(),
      templateIds: z.array(IdSchema),
      templateRows: z.string(),
      structurallyValid: z.boolean(),
    })
    .nullable()
    .optional(),
  timeZone: z.string(),
  role: ScanRoleSchema.nullable(),
  staff: z
    .strictObject({
      id: IdSchema,
      name: z.string(),
      role: ScanRoleSchema,
      updatedAt: TimestampSchema,
    })
    .nullable(),
  settings: ScannerSettingsSchema.strict(),
  name: z.string(),
  terminal: z.boolean(),
  scannerCsrfProof: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  credentialKeysetCommitment: z.string().regex(/^[a-f0-9]{64}$/),
  scanningSession: z
    .strictObject({
      id: IdSchema,
      status: z.enum(['active', 'paused', 'ended']),
      updatedAt: TimestampSchema,
    })
    .optional(),
  platformSessionId: z.string().min(1).optional(),
  tenantAuthority: z
    .strictObject({
      kind: z.literal('session'),
      orgId: IdSchema,
      orgUpdatedAt: revisionNumber,
      userId: IdSchema,
      userAccessRevision: revisionNumber.optional(),
      sessionId: z.string().min(1),
      membershipId: IdSchema,
      sessionCreatedAt: TimestampSchema,
      sessionExpiresAt: TimestampSchema,
      sessionCsrfProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      roles: OrgRolesSchema,
      sessionRoles: z.array(RoleSchema).min(1),
      amr: z.enum(['oidc', 'magic_link', 'breakglass']),
      capability: z.enum(['scanning:read', 'passes:operate']),
      mode: ModeSchema,
    })
    .optional(),
});

const sourceProofSchema = z
  .strictObject({
    actor: liveActorSchema,
    eventId: IdSchema,
    credentialContext: z.strictObject({
      credentialKeysetCommitment: z.string().regex(/^[a-f0-9]{64}$/),
      credentialTombstoneRefs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(3)
        .refine((refs) => new Set(refs).size === refs.length),
      otherModeCredentialTombstoneRefs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(3)
        .refine((refs) => new Set(refs).size === refs.length),
    }),
    passId: IdSchema.nullable(),
    passSnapshot: z
      .strictObject({
        version: revisionNumber,
        revision: revisionNumber,
        linkGeneration: revisionNumber,
        credentialGeneration: z.number().int().positive(),
        lifecycleGeneration: revisionNumber,
        imageGeneration: revisionNumber,
        transferPending: z.boolean(),
        credentialTombstoneRefs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(3),
        otherModeCredentialTombstoneRefs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(3),
        credentialKeysetCommitment: z.string().regex(/^[a-f0-9]{64}$/),
        passReleaseId: IdSchema.nullable(),
        passCommitment: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        walletVersion: z.number().int().positive().nullable(),
        walletTemplateVersion: z.string().nullable(),
        connectionGeneration: revisionNumber.nullable(),
        activeTemplateVersion: z.string().min(1).nullable(),
        displayTemplateVersion: z.string().min(1).nullable(),
        orgRevision: revisionNumber.nullable(),
        templateRevision: revisionNumber.nullable(),
        identityRevision: z.number().int().positive().nullable(),
        activeReleaseId: IdSchema.nullable(),
        activeReleaseGeneration: revisionNumber.nullable(),
        activeReleaseVersion: z.string().min(1).nullable(),
        activeReleaseCandidateHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .nullable(),
    at: TimestampSchema,
  })
  .refine(
    ({ actor, passId, passSnapshot, credentialContext }) =>
      (passId === null) === (passSnapshot === null) &&
      validCredentialTombstoneRefs(credentialContext.credentialTombstoneRefs) &&
      validCredentialTombstoneRefs(credentialContext.otherModeCredentialTombstoneRefs) &&
      actor.credentialKeysetCommitment === credentialContext.credentialKeysetCommitment &&
      (!passSnapshot ||
        (passSnapshot.credentialKeysetCommitment === credentialContext.credentialKeysetCommitment &&
          passSnapshot.credentialTombstoneRefs.length ===
            credentialContext.credentialTombstoneRefs.length &&
          passSnapshot.credentialTombstoneRefs.every(
            (ref, index) => ref === credentialContext.credentialTombstoneRefs[index],
          ) &&
          passSnapshot.otherModeCredentialTombstoneRefs.length ===
            credentialContext.otherModeCredentialTombstoneRefs.length &&
          passSnapshot.otherModeCredentialTombstoneRefs.every(
            (ref, index) => ref === credentialContext.otherModeCredentialTombstoneRefs[index],
          ))) &&
      actor.scanner.orgId === actor.orgId &&
      actor.scanner.mode === actor.mode &&
      actor.scanner.deviceRole === 'scan' &&
      (actor.event === null ||
        (actor.event.orgId === actor.orgId && actor.event.mode === actor.mode)) &&
      (actor.principal === 'admin'
        ? actor.actor.type === 'user' &&
          !!actor.platformSessionId &&
          !!actor.tenantAuthority &&
          actor.tenantAuthority.orgId === actor.orgId &&
          actor.tenantAuthority.userId === actor.actor.id &&
          actor.tenantAuthority.sessionId === actor.platformSessionId &&
          actor.tenantAuthority.mode === actor.mode &&
          actor.tenantAuthority.sessionExpiresAt > actor.tenantAuthority.sessionCreatedAt
        : actor.actor.type === 'scanner' &&
          actor.actor.id === actor.scanner.id &&
          (actor.terminal ? actor.scannerCsrfProof === null : !!actor.scannerCsrfProof)),
  );

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
export async function sealLiveSourceProof(env: object, proof: LiveSourceProof): Promise<string> {
  const scanner = proof.actor.scanner;
  const observation = captureObservedScanningSession(proof.actor);
  if (!scanner) throw new Error('Invalid live source authority.');
  if (
    scanner.csrfSecret !== null ||
    (proof.actor.scanningSession && !observation) ||
    !proof.credentialContext ||
    !validCredentialTombstoneRefs(proof.credentialContext.credentialTombstoneRefs) ||
    !validCredentialTombstoneRefs(proof.credentialContext.otherModeCredentialTombstoneRefs) ||
    !/^[a-f0-9]{64}$/.test(proof.credentialContext.credentialKeysetCommitment) ||
    !sourceProofSchema.safeParse(proof).success
  )
    throw new Error('Invalid live source authority.');
  const epochs = scanEpochsOf(proof.actor);
  // An actor the guard never captured cannot be checked at read time.
  if (!epochs) throw new Error('Invalid live source authority.');
  const payload = encoder.encode(JSON.stringify({ proof, observation, epochs }));
  return sealLiveSourceEnvelope(env, payload, {
    orgId: proof.actor.orgId,
    mode: proof.actor.mode,
    scannerId: scanner.id,
    eventId: proof.eventId,
  });
}

/** Invalid, truncated, unrecognized or unauthenticated proofs never authorize a photo. */
export async function openLiveSourceProof(
  env: object,
  proof: string,
): Promise<LiveSourceProof | null> {
  const opened = await openLiveSourceEnvelope(env, proof);
  if (!opened) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(opened.plaintext));
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, 'proof') ||
      !Object.hasOwn(value, 'observation') ||
      !Object.hasOwn(value, 'epochs')
    )
      return null;
    const envelope = value as { proof: unknown; observation: unknown; epochs: unknown };
    if (!sourceProofSchema.safeParse(envelope.proof).success) return null;
    // A proof sealed before epochs existed has none and cannot authorize a read.
    const epochs = epochsSchema.safeParse(envelope.epochs);
    if (!epochs.success) return null;
    // Do not replace the actor with Zod's projection: its original authority fields are needed.
    const result = envelope.proof as LiveSourceProof;
    if (
      result.actor.orgId !== opened.binding.orgId ||
      result.actor.mode !== opened.binding.mode ||
      result.actor.scanner?.id !== opened.binding.scannerId ||
      result.eventId !== opened.binding.eventId
    )
      return null;
    if (!restoreObservedScanningSession(result.actor, envelope.observation)) return null;
    setScanEpochs(result.actor, epochs.data as ScanAuthorityEpochs);
    return result;
  } catch {
    return null;
  }
}
