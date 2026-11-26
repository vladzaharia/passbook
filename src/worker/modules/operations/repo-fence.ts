import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';

/**
 * Who may read which rows, as SQL. `ctes` follow `WITH` (empty for a starter read); `where` is ANDed onto
 * the `operations` alias `o`. Revoked membership, key, session or org epoch removes the rows at once.
 */
export interface Fence {
  ctes: string;
  ctesParams: SqlValue[];
  where: string;
  whereParams: SqlValue[];
}

/** Org rows of the actor's own org and mode. The org and mode come from the actor row, never the request. */
export function orgFence(principal: Principal, checks: Check[], now: number): Fence {
  const { ctes, params } = authorityPredicate(principal, { scope: 'org_mode', now, checks });
  return {
    ctes,
    ctesParams: params,
    where: `o.audience = 'org' AND EXISTS (SELECT 1 FROM actor_ok)
      AND o.org_id = (SELECT org_id FROM actor_ok) AND o.mode = (SELECT mode FROM actor_ok)
      AND (SELECT limit_key FROM actor_ok) IS NULL`,
    whereParams: [],
  };
}

/** Platform rows for a live admin session. */
export function platformFence(
  principal: Extract<Principal, { kind: 'platform' }>,
  now: number,
): Fence {
  const { ctes, params } = authorityPredicate(principal, { scope: 'platform', now });
  return {
    ctes,
    ctesParams: params,
    where: `o.audience = 'platform' AND EXISTS (SELECT 1 FROM actor_ok)`,
    whereParams: [],
  };
}

/**
 * Rows a person started, for the live session that asks. A key never reads these.
 * `writer`: stopping or retrying needs the person's own live, strong session (a step-up replaces the one that started it).
 * `ownSession`: an own-only session (an email link) sees only what its own session started.
 * `pinnedOrg`: a Workbench token sees only the person's rows in that org's Test mode.
 */
export function starterFence(
  session: { userId: string; sessionId: string },
  now: number,
  options: { writer?: boolean; ownSession?: boolean; pinnedOrg?: string } = {},
): Fence {
  const { writer = false, ownSession = false, pinnedOrg } = options;
  return {
    ctes: '',
    ctesParams: [],
    where: `o.audience = 'starter' AND o.actor_type = 'user' AND o.actor_id = ?${ownSession ? ' AND o.actor_session = ?' : ''}
      ${pinnedOrg === undefined ? '' : "AND o.org_id = ? AND o.mode = 'test'"}
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_hash = ? AND s.user_id = ? AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ?${writer ? ` AND s.amr IN ${STRONG_AMR_SQL}` : ''})`,
    whereParams: [
      session.userId,
      ...(ownSession ? [session.sessionId] : []),
      ...(pinnedOrg === undefined ? [] : [pinnedOrg]),
      session.sessionId,
      session.userId,
      now,
      now,
    ],
  };
}
