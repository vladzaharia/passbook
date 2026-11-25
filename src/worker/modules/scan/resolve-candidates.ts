import type { PassJson } from '../../../passkit/types.ts';
import type { ScanCodeInput } from '../../../shared/contracts/scan.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import { printCodeRef } from '../prints/codes.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  scanCredentialKeys,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import {
  credentialTombstonesClearStmt,
  validCredentialKeysetCommitment,
} from './repo-credential-tombstones.ts';
import {
  byBarcodeHashStmt,
  byIdStmt,
  byLookupHashStmt,
  byPrintHashStmt,
  byScanCodeStmt,
  bySerialStmt,
  type Candidate,
  candidatesOf,
} from './repo-lookup.ts';
import { scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import { type CandidateMatchInput, candidateCapacityStmt } from './repo-resolve-candidates.ts';
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

/**
 * A claim guard proves the immediately preceding new claim; null makes a read-only plan; without one
 * (a resolve) the actor's read authority guards the keyset's first initialization.
 */
export async function planCandidateReads(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanCodeInput,
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
  const stmts: D1PreparedStatement[] = [
    credentialTombstonesClearStmt(
      db,
      actor.orgId,
      actor.mode,
      refs.credentialTombstoneRefs,
      refs.credentialKeysetCommitment,
    ),
  ];
  const matchKinds: NonNullable<Candidate['matchedBy']>[] = [];
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
      const printRef = await printCodeRef(ctx.env, actor.orgId, actor.mode, clean);
      capacityInput = {
        scanCode,
        barcodeHash,
        lookupHash,
        serial: input.method === 'manual' ? clean : null,
        printRef,
      };
      if (scanCode) {
        stmts.push(byScanCodeStmt(db, actor.orgId, scanCode, actor.mode));
        matchKinds.push('scan_code');
      }
      stmts.push(byBarcodeHashStmt(db, actor.orgId, barcodeHash, actor.mode));
      stmts.push(byLookupHashStmt(db, actor.orgId, lookupHash, actor.mode));
      matchKinds.push('barcode', 'lookup');
      if (input.method === 'manual') {
        stmts.push(bySerialStmt(db, actor.orgId, clean, actor.mode));
        matchKinds.push('serial');
      }
      if (printRef) {
        stmts.push(byPrintHashStmt(db, actor.orgId, printRef, actor.mode));
        matchKinds.push('print');
        // A print of the other mode answers test_pass or live_pass, as a wallet code does.
        const otherMode = actor.mode === 'live' ? 'test' : 'live';
        const otherRef = await printCodeRef(ctx.env, actor.orgId, otherMode, clean);
        if (otherRef) {
          stmts.push(byPrintHashStmt(db, actor.orgId, otherRef, otherMode));
          matchKinds.push('print');
        }
      }
    }
  }
  const now = ctx.clock.now();
  const guard =
    initGuard === undefined
      ? scanReadFence(scanReadAuthority(actor, { now }))
      : (initGuard?.(now) ?? null);
  if (initialize && !guard) return { now, stmts: [], capacityStmt: null, finish: () => null };
  // On a grant, the keyset write is the grant's part: a placeholder keeps the result positions.
  if (guard && keysetOnGrant) stmts.unshift(stmt(db, 'SELECT 1 AS keyset_on_grant'));
  else if (guard)
    stmts.unshift(credentialRefKeysetInitializeStmt(db, refs.credentialKeysetCommitment, guard));
  const capacityStmt = candidateCapacityStmt(db, actor, capacityInput);
  return {
    now,
    stmts,
    capacityStmt,
    finish(results) {
      const clearIndex = initialize ? 1 : 0;
      if (!results[clearIndex]?.results?.length) return null;
      let otherMode: Candidate[] = [];
      for (const [i, result] of results.slice(clearIndex + 1).entries()) {
        const matchedBy = matchKinds[i];
        const hit = candidatesOf(result);
        if (
          hit.some(
            (candidate) => candidate.credentialKeysetCommitment !== refs.credentialKeysetCommitment,
          )
        )
          return null;
        const current = hit.filter((candidate) => candidate.pass.mode === actor.mode);
        if (current.length)
          return current.map((candidate) => Object.assign(candidate, refs, { matchedBy }));
        if (!otherMode.length) otherMode = hit.map((c) => Object.assign(c, { matchedBy }));
      }
      return otherMode.map((candidate) => Object.assign(candidate, refs));
    },
  };
}
export async function findCandidates(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanCodeInput,
  refs: CredentialTombstoneSnapshot,
): Promise<Candidate[] | null> {
  const plan = await planCandidateReads(ctx, actor, input, refs);
  return plan.stmts.length ? plan.finish(await ctx.env.DB.batch(plan.stmts)) : null;
}

export const accepts = (actor: ScanActor, pass: Pass) =>
  actor.overrideScope?.templateId
    ? actor.overrideScope.templateId === pass.templateId
    : actor.templateIds.length === 0
      ? (actor.principal === 'admin' && actor.scanner === null) ||
        actor.settings.acceptAllTemplates === true
      : actor.templateIds.includes(pass.templateId);

export { eventAcceptsPass, matchesEvent } from './admits.ts';

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
