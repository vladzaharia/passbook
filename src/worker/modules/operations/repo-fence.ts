import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';

/**
 * Who may read which rows, as SQL. `ctes` follow `WITH` (empty for a starter read); `from` is the read's
 * FROM term (the actor's `ao` row joined before `operations o`); `where` is ANDed onto the alias `o`. Revoked membership, key, session or org epoch removes the rows at once.
 */
export interface Fence {
  ctes: string;
  from: string;
  ctesParams: SqlValue[];
  where: string;
  whereParams: SqlValue[];
}

/** Org rows of the actor's own org and mode. The org and mode come from the actor row, never the request. */
export function orgFence(principal: Principal, checks: Check[], now: number): Fence {
  const p = authorityPredicate(principal, { scope: 'org_mode', now, checks });
  return {
    ctes: p.ctes,
    from: `${p.rows}operations o`,
    ctesParams: p.params,
    where: `o.audience = 'org' AND ${p.ok}
      AND o.org_id = ao.org_id AND o.mode = ao.mode
      AND ao.limit_key IS NULL`,
    whereParams: [],
  };
}

/** Platform rows for a live admin session. */
export function platformFence(
  principal: Extract<Principal, { kind: 'platform' }>,
  now: number,
): Fence {
  const p = authorityPredicate(principal, { scope: 'platform', now });
  return {
    ctes: p.ctes,
    from: `${p.rows}operations o`,
    ctesParams: p.params,
    where: `o.audience = 'platform' AND ${p.ok}`,
    whereParams: [],
  };
}

/** Rows a live Platform key started itself: no org, and never a session's, another key's or the system's. */
export function platformKeyFence(
  principal: Extract<Principal, { kind: 'api_key' }>,
  now: number,
): Fence {
  const p = authorityPredicate(principal, { scope: 'platform', now });
  return {
    ctes: p.ctes,
    from: `${p.rows}operations o`,
    ctesParams: p.params,
    where: `o.audience IN ('platform', 'starter') AND o.org_id IS NULL AND o.actor_type = 'api_key'
      AND o.actor_id = ? AND ${p.ok}`,
    whereParams: [principal.keyId],
  };
}

/**
 * Rows a person started, for the live session that asks. A key never reads these, but for one condition:
 * `pinnedSandbox`: a sandbox Workbench token (a key, no session) reads what the sandbox's owner started for
 * that sandbox: their sandbox rows whose target is the org, while the sandbox is open. Stop and retry pass the same fence, then the kind's `tokenActs`.
 * `writer`: stopping or retrying needs the person's own live, strong session (a step-up replaces the one that started it).
 * `ownSession`: an own-only session (an email link) sees only what its own session started.
 * `pinnedOrg`: a member Workbench token sees only the person's rows in that org's Test mode.
 */
export function starterFence(
  session: { userId: string; sessionId: string } | null,
  now: number,
  options: {
    writer?: boolean;
    ownSession?: boolean;
    pinnedOrg?: string;
    pinnedSandbox?: string;
  } = {},
): Fence {
  const { writer = false, ownSession = false, pinnedOrg, pinnedSandbox } = options;
  if (!session)
    return {
      ctes: '',
      from: 'operations o',
      ctesParams: [],
      where: `o.audience = 'starter' AND o.actor_type = 'user' AND o.target_type = 'sandbox' AND o.target_id = ?
        AND EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.org_id = ? AND d.user_id = o.actor_id AND d.closed_at IS NULL)`,
      whereParams: [pinnedSandbox ?? '', pinnedSandbox ?? ''],
    };
  return {
    ctes: '',
    from: 'operations o',
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
