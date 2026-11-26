import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';

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

/** Rows a live Platform key started itself: no org, and never a session's, another key's or the system's. */
export function platformKeyFence(
  principal: Extract<Principal, { kind: 'api_key' }>,
  now: number,
): Fence {
  const { ctes, params } = authorityPredicate(principal, { scope: 'platform', now });
  return {
    ctes,
    ctesParams: params,
    where: `o.audience IN ('platform', 'starter') AND o.org_id IS NULL AND o.actor_type = 'api_key'
      AND o.actor_id = ? AND EXISTS (SELECT 1 FROM actor_ok)`,
    whereParams: [principal.keyId],
  };
}

/** Rows a person started, for the live session that started them. A key never reads these. */
export function starterFence(
  session: { userId: string; sessionId: string },
  now: number,
  /** Stopping or retrying: only the session that started it, not the person's other sessions. */
  writer = false,
): Fence {
  return {
    ctes: '',
    ctesParams: [],
    where: `o.audience = 'starter' AND o.actor_type = 'user' AND o.actor_id = ?${writer ? ' AND o.actor_session = ?' : ''}
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_hash = ? AND s.user_id = ? AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ?)`,
    whereParams: [
      session.userId,
      ...(writer ? [session.sessionId] : []),
      session.sessionId,
      session.userId,
      now,
      now,
    ],
  };
}
