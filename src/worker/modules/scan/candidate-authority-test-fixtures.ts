import type { ScanActor } from './guard.ts';
import type { Candidate } from './repo-lookup.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { passAnswerFence, underAuthority } from './repo-read-fences.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { predicateStmt, type ScanPredicate } from './scan-predicate.ts';

/** The fence a pass-bearing answer commits under: the actor's authority and the candidate's pass. */
export function candidateAuthority(
  actor: ScanActor,
  candidate: Candidate | undefined,
  now: number,
  event: ScanEventRow | null = actor.event,
  refs: readonly string[] = [],
): ScanPredicate {
  const inner = candidate && passAnswerFence(actor, candidate, { photo: false, refs });
  if (!inner) throw new Error('No candidate to fence');
  return underAuthority(
    scanReadAuthority(actor, {
      now,
      event,
      templateId: candidate.pass.templateId,
    }),
    inner,
  );
}

/** Whether `candidateAuthority` holds now. */
export async function candidateAuthorityHolds(
  db: D1Database,
  actor: ScanActor,
  candidate: Candidate,
  now: number,
  event: ScanEventRow | null = actor.event,
  refs: readonly string[] = [],
): Promise<boolean> {
  const row = await predicateStmt(
    db,
    candidateAuthority(actor, candidate, now, event, refs),
  ).first<{
    authorized: number;
  }>();
  return row?.authorized === 1;
}
