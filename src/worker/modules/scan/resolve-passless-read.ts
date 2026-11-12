import type { ScanInput } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import { type CredentialTombstoneSnapshot, scanCredentialKeys } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { prepareReadMiss } from './misses.ts';
import type { Candidate } from './repo-lookup.ts';
import { passOutputPredicate } from './repo-output-authority.ts';
import { detectionOutputPredicate } from './repo-output-detection.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';
import { inputActorFence, inputCandidatesPredicate } from './repo-resolve-passless-read.ts';

export { acceptedFilter, candidateEligible } from './repo-resolve-passless-read.ts';

/** Any newly matching or pending same-mode credential makes a missing result unconfirmed. */
export async function inputCandidates(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
  credentials: CredentialTombstoneSnapshot,
  filter?: OutputPredicate,
): Promise<OutputPredicate> {
  const scope = { orgId: actor.orgId, mode: actor.mode };
  if ('passId' in input) return inputCandidatesPredicate(scope, { passId: input.passId }, filter);
  const keys = await scanCredentialKeys(
    ctx.env,
    actor.orgId,
    actor.mode,
    input.code,
    true,
    credentials,
  );
  return inputCandidatesPredicate(
    scope,
    keys.clean
      ? {
          scanCode: keys.scanCode,
          barcodeHash: keys.barcodeHash,
          lookupHash: keys.lookupHash,
          serial: input.method === 'manual' ? keys.clean : null,
        }
      : null,
    filter,
  );
}

export function candidateReadProof(
  actor: ScanActor,
  candidate: Candidate,
  credentials: CredentialTombstoneSnapshot,
  now: number,
): OutputPredicate {
  const modeRefs =
    candidate.pass.mode === actor.mode
      ? credentials.credentialTombstoneRefs
      : credentials.otherModeCredentialTombstoneRefs;
  return passOutputPredicate({
    now,
    pass: candidate.pass,
    connectionGeneration: candidate.connectionGeneration,
    activeTemplateVersion: candidate.activeTemplateVersion,
    orgRevision: candidate.orgRevision,
    templateRevision: candidate.templateRevision,
    credentialTombstoneRefs: modeRefs,
    credentialKeysetCommitment: credentials.credentialKeysetCommitment,
    release: { ...candidate, credentialTombstoneRefs: modeRefs },
    displayTemplateVersion: candidate.displayTemplateVersion,
    checkInRules: candidate.checkInRules,
    lookupHash: candidate.lookupHash,
  });
}

/** Actor-only reasons must not reveal a credential retired since candidate resolution. */
export async function currentInputActor(
  ctx: ServiceContext,
  actor: ScanActor,
  csrfSnapshot: ActorCsrfSnapshot,
  refs: readonly string[] | undefined,
  commitment: string | undefined,
  otherRefs?: readonly string[],
  bothModes = false,
  candidates?: OutputPredicate,
  proofsAt: (now: number) => readonly OutputPredicate[] = () => [],
  absence?: OutputPredicate,
): Promise<boolean> {
  if (
    typeof commitment !== 'string' ||
    !Array.isArray(refs) ||
    (bothModes && !Array.isArray(otherRefs))
  )
    return false;
  const now = ctx.clock.now();
  const csrf = actorCsrfSnapshotFence(
    actor,
    csrfSnapshot.session
      ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
      : csrfSnapshot,
  );
  if (!csrf) return false;
  const predicate = inputActorFence(
    actor,
    csrf,
    refs,
    commitment,
    otherRefs,
    bothModes,
    absence,
    now,
  );
  if (!predicate) return false;
  const fence = outputPredicateStmt(ctx.env.DB, predicate);
  const proofStmts = proofsAt(now).map((proof) => outputPredicateStmt(ctx.env.DB, proof));
  if (!candidates && !proofStmts.length)
    return (await fence.first<{ authorized: number }>())?.authorized === 1;
  const miss = candidates
    ? prepareReadMiss({ ...ctx, clock: { now: () => now } }, actor, {
        csrf,
        credentials: { credentialKeysetCommitment: commitment, credentialTombstoneRefs: refs },
        visible: [],
        candidates,
      })
    : null;
  const results = await ctx.env.DB.batch<Record<string, unknown>>([
    fence,
    ...proofStmts,
    ...(miss?.stmts ?? []),
  ]);
  if (
    results[0]?.results?.[0]?.authorized !== 1 ||
    proofStmts.some((_, index) => results[index + 1]?.results?.[0]?.authorized !== 1)
  )
    return false;
  if (!miss) return true;
  const status = miss.result(results.slice(1 + proofStmts.length));
  miss.throwIfCapped(status);
  return status === 'counted';
}

/** Proof for a cross-mode detection: the other-mode credential is still the one observed. */
export function candidateDetectionProof(
  actor: ScanActor,
  candidate: Candidate,
  credentials: CredentialTombstoneSnapshot,
): OutputPredicate {
  const refs =
    candidate.pass.mode === actor.mode
      ? credentials.credentialTombstoneRefs
      : credentials.otherModeCredentialTombstoneRefs;
  return detectionOutputPredicate({
    pass: candidate.pass,
    credentialTombstoneRefs: refs,
    credentialKeysetCommitment: credentials.credentialKeysetCommitment,
  });
}
