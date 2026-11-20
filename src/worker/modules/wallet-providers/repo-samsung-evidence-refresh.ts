import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { reprobeSamsungProjectionEvidence } from './samsung-verification.ts';

const AHEAD_MS = 60_000;

/**
 * Evidence lives five minutes. A request path (Get Card Data, an offer) only reads the cached proof and cannot write
 * one, so the sync job refreshes the proof of every approved Samsung candidate before it lapses.
 */
export async function refreshExpiringSamsungEvidence(
  ctx: ServiceContext,
  limit: number,
): Promise<number> {
  const due = await all<{ id: string; hash: string }>(
    ctx.env.DB,
    `SELECT c.id, c.candidate_hash AS hash FROM template_candidates c
    JOIN template_approvals approval ON approval.candidate_id = c.id
    JOIN wallet_provider_projection_evidence e ON e.candidate_id = c.id AND e.status = 'verified'
    WHERE c.provider = 'samsung' AND e.expires_at <= ?
    ORDER BY e.expires_at LIMIT ?`,
    [ctx.clock.now() + AHEAD_MS, limit],
  );
  let refreshed = 0;
  for (const candidate of due) {
    try {
      if (await reprobeSamsungProjectionEvidence(ctx, candidate.id, candidate.hash)) refreshed++;
    } catch {
      ctx.log.warn('wallet.evidence_refresh_failed', { code: 'WALLET_EVIDENCE_REFRESH' });
    }
  }
  return refreshed;
}
