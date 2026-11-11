import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { actionCsrfAt } from './act-snapshot.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { credentialTombstonePredicate } from './repo-gates.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';
import { type Claim, pristineClaimFence } from './repo-scans.ts';
import type { Found } from './resolve.ts';

/** Fence invalid-action handling to the original actor, candidate, credentials and claim. */
export function invalidAttemptAuthority(
  ctx: ServiceContext,
  authorityActor: ScanActor,
  req: ActRequest,
  credentials: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
  ownedClaim: Claim,
  invalidFound: Found | null,
): OutputPredicate {
  const now = ctx.clock.now();
  const candidate = invalidFound?.liveCandidate;
  if (invalidFound && !candidate) return { sql: '0', params: [] };
  const template = candidate ? scanCandidateTemplateReadPredicate(candidate) : null;
  const authority =
    candidate && invalidFound
      ? outputAuthorityPredicate({
          actor: authorityActor,
          now,
          event: invalidFound.admission?.event ?? null,
          adminEventTemplates:
            authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
          templateId: candidate.pass.templateId,
          pass: candidate.pass,
          connectionGeneration: candidate.connectionGeneration,
          activeTemplateVersion: candidate.activeTemplateVersion,
          orgRevision: candidate.orgRevision,
          templateRevision: candidate.templateRevision,
          release: candidate,
          credentialKeysetCommitment: credentials.credentialKeysetCommitment,
          credentialTombstoneRefs: credentials.credentialTombstoneRefs,
          purpose: 'commit',
          displayTemplateVersion: candidate.displayTemplateVersion,
          checkInRules: candidate.checkInRules,
          lookupHash: candidate.lookupHash,
          requireActive: true,
          extra: template ?? undefined,
        })
      : actorAuthorityPredicate({
          actor: authorityActor,
          now,
          event: authorityActor.event,
          adminEventTemplates:
            authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
        });
  const csrf = actionCsrfAt(authorityActor, csrfSnapshot, now);
  if (!csrf) return { sql: '0', params: [] };
  const tokens = credentialTombstonePredicate(
    authorityActor.orgId,
    authorityActor.mode,
    credentials.credentialTombstoneRefs,
    credentials.credentialKeysetCommitment,
  );
  const original = pristineClaimFence(ownedClaim);
  return boundOutputPredicate({
    sql: `(${authority.sql}) AND (${csrf.sql}) AND (${tokens.sql}) AND (${original.sql})`,
    params: [...authority.params, ...csrf.params, ...tokens.params, ...original.params],
  });
}
