import type { PassJson } from '../../../passkit/types.ts';
import type { ScanInput } from '../../../shared/contracts/scan.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  scanCredentialKeys,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { boundedClaimPredicate } from './repo-act-claim-lifecycle.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import {
  credentialTombstonesClearStmt,
  validCredentialKeysetCommitment,
} from './repo-credential-tombstones.ts';
import { eventMatch } from './repo-event-match.ts';
import {
  byBarcodeHashStmt,
  byIdStmt,
  byLookupHashStmt,
  byScanCodeStmt,
  bySerialStmt,
  type Candidate,
  candidatesOf,
} from './repo-lookup.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import {
  type CandidateMatchInput,
  candidateCapacityStmt,
  candidateReadGuard,
} from './repo-resolve-candidates.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { walletIdentityMatches } from './wallet-snapshot.ts';

export interface TemplateRef {
  name: string;
  style: string;
}

export interface CandidateReadPlan {
  now: number;
  stmts: D1PreparedStatement[];
  /** Conservative same-mode history counts, batched by the action caller when needed. */
  capacityStmt: D1PreparedStatement | null;
  finish(results: readonly D1Result[]): Candidate[] | null;
}

/** A claim guard proves the immediately preceding new claim; null makes a read-only plan. */
export async function planCandidateReads(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
  refs: CredentialTombstoneSnapshot,
  initGuard?: ((now: number) => { sql: string; params: readonly SqlValue[] } | null) | null,
  keysetOnGrant = false,
): Promise<CandidateReadPlan> {
  input = { ...input };
  actor = cloneObservedScanActor(actor);
  ctx = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const db = ctx.env.DB;
  if (!credentialInputValid(input, refs))
    return { now: ctx.clock.now(), stmts: [], capacityStmt: null, finish: () => null };
  refs = captureCredentialTombstoneSnapshot(refs);
  const initialize = initGuard !== null;
  const csrfQuery = initGuard === undefined ? actorCsrfAuthorityStmt(db, actor) : null;
  const csrfSnapshot =
    initGuard === undefined && csrfQuery
      ? await actorCsrfSnapshotFromResult(ctx, actor, await csrfQuery.all())
      : null;
  if (initGuard === undefined && !csrfSnapshot)
    return { now: ctx.clock.now(), stmts: [], capacityStmt: null, finish: () => null };
  const stmts: D1PreparedStatement[] = [
    credentialTombstonesClearStmt(
      db,
      actor.orgId,
      actor.mode,
      refs.credentialTombstoneRefs,
      refs.credentialKeysetCommitment,
    ),
  ];
  let capacityInput: CandidateMatchInput | null = null;
  if ('passId' in input) {
    stmts.push(byIdStmt(db, actor.orgId, input.passId));
    capacityInput = { passId: input.passId };
  } else {
    const { clean, scanCode, barcodeHash, lookupHash } = await scanCredentialKeys(
      ctx.env,
      actor.orgId,
      actor.mode,
      input.code,
      true,
      refs,
    );
    if (clean) {
      capacityInput = {
        scanCode,
        barcodeHash,
        lookupHash,
        serial: input.method === 'manual' ? clean : null,
      };
      if (scanCode) stmts.push(byScanCodeStmt(db, actor.orgId, scanCode, actor.mode));
      stmts.push(byBarcodeHashStmt(db, actor.orgId, barcodeHash, actor.mode));
      stmts.push(byLookupHashStmt(db, actor.orgId, lookupHash, actor.mode));
      if (input.method === 'manual') stmts.push(bySerialStmt(db, actor.orgId, clean, actor.mode));
    }
  }
  const now = ctx.clock.now();
  let guard = initGuard?.(now) ?? null;
  if (initGuard === undefined && csrfSnapshot) {
    const csrf = actorCsrfSnapshotFence(
      actor,
      csrfSnapshot.session
        ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
        : csrfSnapshot,
    );
    const authority = actorAuthorityPredicate({
      actor,
      now,
      event: actor.event,
      adminEventTemplates: actor.adminEventTemplates === true,
    });
    guard = csrf ? candidateReadGuard(authority, csrf) : null;
  }
  if (initialize && !guard) return { now, stmts: [], capacityStmt: null, finish: () => null };
  // On a grant, the keyset write is the grant's part: a placeholder keeps the result positions.
  if (guard && keysetOnGrant) stmts.unshift(stmt(db, 'SELECT 1 AS keyset_on_grant'));
  else if (guard)
    stmts.unshift(
      credentialRefKeysetInitializeStmt(
        db,
        refs.credentialKeysetCommitment,
        initGuard ? boundedClaimPredicate(guard, 1) : boundOutputPredicate(guard),
      ),
    );
  const capacityStmt = candidateCapacityStmt(db, actor, capacityInput);
  return {
    now,
    stmts,
    capacityStmt,
    finish(results) {
      const clearIndex = initialize ? 1 : 0;
      if (!results[clearIndex]?.results?.length) return null;
      let otherMode: Candidate[] = [];
      for (const result of results.slice(clearIndex + 1)) {
        const hit = candidatesOf(result);
        if (
          hit.some(
            (candidate) => candidate.credentialKeysetCommitment !== refs.credentialKeysetCommitment,
          )
        )
          return null;
        const current = hit.filter((candidate) => candidate.pass.mode === actor.mode);
        if (current.length) return current.map((candidate) => Object.assign(candidate, refs));
        if (!otherMode.length) otherMode = hit;
      }
      return otherMode.map((candidate) => Object.assign(candidate, refs));
    },
  };
}
export async function findCandidates(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
  refs: CredentialTombstoneSnapshot,
): Promise<Candidate[] | null> {
  const plan = await planCandidateReads(ctx, actor, input, refs);
  return plan.stmts.length ? plan.finish(await ctx.env.DB.batch(plan.stmts)) : null;
}

export const accepts = (actor: ScanActor, pass: Pass) =>
  actor.templateIds.length === 0
    ? (actor.principal === 'admin' && actor.scanner === null) ||
      actor.settings.acceptAllTemplates === true
    : actor.templateIds.includes(pass.templateId);

export function matchesEvent(actor: ScanActor, pass: Pass): boolean {
  const event = actor.event;
  if (!event) return true;
  if (event.orgId !== actor.orgId || event.mode !== actor.mode || event.archivedAt !== null)
    return false;
  const match = eventMatch(event.matchInput, event.matchValues);
  if (!match) return false;
  if (match.input === null) return true;
  if (!Object.hasOwn(pass.personalization, match.input)) return false;
  const value = pass.personalization[match.input];
  if (typeof value === 'boolean') return match.values.includes(value ? '1' : '0');
  return (
    (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) &&
    match.values.includes(String(value))
  );
}

/** Only credentials observed without a pending transfer can authorize a scan. */
export function candidateCredentialSnapshotValid(candidate: Candidate): boolean {
  return (
    candidate.transferPending === false &&
    validCredentialKeysetCommitment(candidate.credentialKeysetCommitment) &&
    typeof candidate.pass.credentialGeneration === 'number' &&
    Number.isSafeInteger(candidate.pass.credentialGeneration) &&
    candidate.pass.credentialGeneration >= 1 &&
    typeof candidate.pass.lifecycleGeneration === 'number' &&
    Number.isSafeInteger(candidate.pass.lifecycleGeneration) &&
    candidate.pass.lifecycleGeneration >= 0 &&
    typeof candidate.pass.imageGeneration === 'number' &&
    Number.isSafeInteger(candidate.pass.imageGeneration) &&
    candidate.pass.imageGeneration >= 0
  );
}

/** Parse only the stored Wallet snapshot and bind it to the observed signing identity. */
export function candidateWallet(candidate: Candidate): PassJson | null {
  if (
    !candidate.passJsonSnapshot ||
    candidate.passJson !== candidate.passJsonSnapshot ||
    typeof candidate.walletVersion !== 'number' ||
    !Number.isSafeInteger(candidate.walletVersion) ||
    candidate.walletVersion < 1 ||
    candidate.walletVersion > candidate.pass.version ||
    !candidateCredentialSnapshotValid(candidate) ||
    (candidate.versionPersonalization !== null &&
      typeof candidate.versionPersonalization !== 'string') ||
    typeof candidate.identityRevision !== 'number' ||
    !Number.isSafeInteger(candidate.identityRevision) ||
    candidate.identityRevision < 1
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(candidate.passJsonSnapshot);
    return walletIdentityMatches(candidate, parsed) ? (parsed as PassJson) : null;
  } catch {
    return null;
  }
}

export function candidateAudit(one: Candidate) {
  const pass = one.pass;
  return {
    auditPassId: pass.id,
    auditCandidate: one,
    connectionGeneration: one.connectionGeneration,
    auditPassSnapshot: {
      orgId: pass.orgId,
      mode: pass.mode,
      identityId: pass.identityId,
      serial: pass.serial,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      version: pass.version,
      revision: pass.revision,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      imageGeneration: pass.imageGeneration,
      linkGeneration: pass.linkGeneration,
      status: pass.status,
      removedAt: pass.removedAt,
      deletedAt: pass.deletedAt,
      testDataQuarantined: pass.testDataQuarantined,
      connectionId: pass.connectionId,
      connectionGeneration: one.connectionGeneration,
      passPersonalizationSnapshot: one.passPersonalizationSnapshot,
      fieldSourcesSnapshot: one.fieldSourcesSnapshot,
      assetPhoto: one.assetPhoto,
      passJsonSnapshot: one.passJsonSnapshot,
      walletVersion: one.walletVersion,
      walletTemplateVersion: one.walletTemplateVersion,
      versionPersonalization: one.versionPersonalization,
      identityPassTypeIdentifier: one.identityPassTypeIdentifier,
      identityTeamIdentifier: one.identityTeamIdentifier,
      transferPending: one.transferPending,
      credentialKeysetCommitment: one.credentialKeysetCommitment,
      credentialTombstoneRefs: one.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: one.otherModeCredentialTombstoneRefs,
      identityRevision: one.identityRevision,
      activeReleaseId: one.activeReleaseId,
      activeReleaseGeneration: one.activeReleaseGeneration,
      activeReleaseVersion: one.activeReleaseVersion,
      activeReleaseCandidateHash: one.activeReleaseCandidateHash,
      activeTemplateVersion: one.activeTemplateVersion,
      orgRevision: one.orgRevision,
      templateRevision: one.templateRevision,
    },
  };
}
