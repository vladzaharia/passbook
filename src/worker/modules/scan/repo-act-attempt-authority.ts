import type { ServiceContext } from '../../platform/service-context.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { passAnswerFence, refsClear, underAuthorityCtes } from './repo-read-fences.ts';
import { type Claim, pristineClaimFence } from './repo-scans.ts';
import type { Found } from './resolve.ts';
import type { ScanPredicate } from './scan-predicate.ts';

const DENIED: ScanPredicate = { sql: '0', params: [] };

/**
 * Fence invalid-action handling to the original actor, candidate and claim: the actor's authority
 * now, the pass the answer was read from still standing under the release it was used under, the
 * credential not retired, and the claim still the one this request opened.
 */
export function invalidAttemptAuthority(
  ctx: ServiceContext,
  actor: ScanActor,
  credentials: CredentialTombstoneSnapshot,
  ownedClaim: Claim,
  invalidFound: Found | null,
): ScanPredicate {
  const candidate = invalidFound?.liveCandidate;
  if (invalidFound && !candidate) return DENIED;
  const refs = credentials.credentialTombstoneRefs;
  if (!validCredentialTombstoneRefs(refs)) return DENIED;
  const auth = scanReadAuthority(actor, {
    now: ctx.clock.now(),
    ...(candidate && invalidFound
      ? {
          event: invalidFound.admission?.event ?? null,
          templateId: candidate.pass.templateId,
        }
      : {}),
  });
  const inner = candidate
    ? passAnswerFence(actor, candidate, { photo: false, refs, staged: true })
    : refsClear(refs);
  if (!inner) return DENIED;
  const staged = underAuthorityCtes(auth, inner);
  const original = pristineClaimFence(ownedClaim);
  return {
    sql: `(${staged.sql}) AND (${original.sql})`,
    params: original.params,
    ctes: staged.ctes,
    cteParams: staged.params,
  };
}
