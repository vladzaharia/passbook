import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { selectSamsungCardsToRefresh } from './repo-samsung-card-state.ts';
import {
  refreshSamsungCardStates,
  reprobeSamsungProjectionEvidence,
} from './samsung-verification.ts';

const AHEAD_MS = 60_000;

/**
 * Candidates whose proof is about to lapse and still matter: the current head release of its template, mode and
 * provider, in an active org, under the account's current epoch. Superseded releases, suspended orgs and rotated
 * accounts hold nothing back, and the oldest expiry goes first.
 */
export function selectExpiringSamsungEvidence(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ id: string; hash: string }[]> {
  return all<{ id: string; hash: string }>(
    db,
    `SELECT c.id, c.candidate_hash AS hash FROM template_releases r
    JOIN template_candidates c ON c.id = r.candidate_id
    JOIN orgs owner ON owner.id = r.org_id AND owner.status = 'active'
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.authority_epoch = c.provider_account_epoch AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    JOIN wallet_provider_projection_evidence e ON e.candidate_id = c.id AND e.status = 'verified'
    WHERE r.provider = 'samsung' AND r.source = 'approved' AND r.action IN ('release', 'rollback')
      AND e.expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = r.template_id
        AND newer.org_id = r.org_id AND newer.mode = r.mode AND newer.provider = r.provider
        AND newer.generation > r.generation)
    ORDER BY e.expires_at LIMIT ?`,
    [now + AHEAD_MS, limit],
  );
}

/**
 * Evidence lives five minutes. A request path (Get Card Data, an offer) only reads the cached proof and cannot write
 * one, so the sync job refreshes the proof of every current Samsung release before it lapses.
 */
export async function refreshExpiringSamsungEvidence(
  ctx: ServiceContext,
  limit: number,
): Promise<number> {
  const now = ctx.clock.now();
  let refreshed = await refreshSamsungCardStates(
    ctx,
    await selectSamsungCardsToRefresh(ctx.env.DB, now, AHEAD_MS, limit),
  );
  for (const candidate of await selectExpiringSamsungEvidence(ctx.env.DB, ctx.clock.now(), limit)) {
    try {
      if (await reprobeSamsungProjectionEvidence(ctx, candidate.id, candidate.hash)) refreshed++;
    } catch {
      ctx.log.warn('wallet.evidence_refresh_failed', { code: 'WALLET_EVIDENCE_REFRESH' });
    }
  }
  return refreshed;
}
