import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { csrfFenceBelongsTo } from './repo-actor-csrf-authority.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';

interface Predicate {
  sql: string;
  params: readonly SqlValue[];
}

export interface ReadMissFence {
  /** The original actor CSRF proof, verified before constructing its scalar SQL fence. */
  csrf: Predicate;
  /** Null only if the read did not observe credential input. */
  credentials: {
    credentialKeysetCommitment: string;
    credentialTombstoneRefs: readonly string[];
  } | null;
  /** True if the original candidate observation is stale or a matching transfer is pending.
   * Raw input and candidate values must use the structural scan-ephemeral bind labels. */
  candidates: Predicate;
  /** Separately bound candidate/window snapshots; sensitive values must be structurally labeled. */
  assertions?: readonly Predicate[];
  /** Exact predicates used by the final item projection; empty for a confirmed empty projection. */
  visible: readonly Predicate[];
}

/** Bind a read miss to the original actor, credential snapshot, and final visible-item predicates. */
export function readMissAuthorityPredicate(
  actor: ScanActor,
  now: number,
  fence: ReadMissFence,
): Predicate {
  const denied = { sql: '0', params: [] };
  if (
    !fence?.csrf ||
    typeof fence.csrf.sql !== 'string' ||
    !Array.isArray(fence.csrf.params) ||
    !fence.candidates ||
    typeof fence.candidates.sql !== 'string' ||
    !Array.isArray(fence.candidates.params) ||
    !Array.isArray(fence.visible) ||
    fence.visible.some(
      (item) => !item || typeof item.sql !== 'string' || !Array.isArray(item.params),
    ) ||
    (fence.assertions !== undefined &&
      (!Array.isArray(fence.assertions) ||
        fence.assertions.some(
          (item) => !item || typeof item.sql !== 'string' || !Array.isArray(item.params),
        )))
  )
    return denied;

  // The fence must come from actorCsrfSnapshotFence for this actor: a valid fence captured for
  // another actor must not authorize this actor's counter.
  if (!csrfFenceBelongsTo(fence.csrf, actor)) return denied;

  const authority = actorAuthorityPredicate({
    actor,
    now,
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const parts = [`(${authority.sql})`, `(${fence.csrf.sql})`];
  const params: SqlValue[] = [...authority.params, ...fence.csrf.params];
  if (fence.credentials === null) {
    if (actor.credentialKeysetCommitment !== undefined) return denied;
  } else {
    const credentials = fence.credentials;
    if (!credentials || credentials.credentialKeysetCommitment !== actor.credentialKeysetCommitment)
      return denied;
    const clear = noCredentialTombstonesSql(
      credentials.credentialTombstoneRefs,
      { orgIdSql: '?', modeSql: '?' },
      credentials.credentialKeysetCommitment,
    );
    if (clear.sql === '0') return denied;
    parts.push(`(${clear.sql})`);
    if (credentials.credentialTombstoneRefs.length) params.push(actor.orgId, actor.mode);
    params.push(...clear.params);
  }
  // A changed candidate observation or matching pending transfer makes the miss uncertain.
  // NULL is uncertain too, rather than evidence that the observation is current.
  parts.push(`COALESCE((${fence.candidates.sql}),1)=0`);
  params.push(...fence.candidates.params);
  for (const item of fence.visible) {
    // Match outputPredicateStmt: SQL NULL also means that the item is not visible.
    parts.push(`NOT COALESCE((${item.sql}),0)`);
    params.push(...item.params);
  }
  // This parser keeps each labeled secret in a standalone bind, never packed metadata.
  return boundOutputPredicate({ sql: parts.join(' AND '), params });
}

/** Abort the whole caller batch if an independently bound observation is no longer current. */
export function requireReadMissObservationStmt(
  db: D1Database,
  predicate: Predicate,
): D1PreparedStatement {
  const bound = boundOutputPredicate(predicate);
  return stmt(
    db,
    `SELECT CASE WHEN (${bound.sql}) THEN 1
    ELSE json_extract('[]', '$[scan_read_miss_stale]') END AS current`,
    bound.params,
  );
}

/** Only the deliberate stale-observation sentinel maps to a generic stale read. */
export function isReadMissStale(error: unknown): boolean {
  return error instanceof Error && error.message.includes('scan_read_miss_stale');
}

/** Misses for one actor are independent across tenants and live/test modes. */
export function missCounterKey(actor: ScanActor): string {
  return `scan:miss:${JSON.stringify([actor.orgId, actor.mode, actor.actorKey])}`;
}

/** The immediately preceding increment must have crossed the cap in this transaction. */
export function cappedMissAuditStmt(
  db: D1Database,
  input: {
    actor: ScanActor;
    key: string;
    window: number;
    threshold: number;
    at: number;
    requestId: string | null;
  },
): D1PreparedStatement {
  const { actor, key, window, threshold, at, requestId } = input;
  return stmt(
    db,
    `INSERT INTO audit_log
    (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
    SELECT ?, ?, ?, ?, 'scan.misses_capped', ?, ?, ?, NULL, NULL
    WHERE changes()=1 AND EXISTS (SELECT 1 FROM counters
      WHERE key=? AND window_start=? AND count=?)`,
    [
      at,
      actor.orgId,
      actor.actor.type,
      actor.actor.id,
      actor.scanner ? 'scanner' : null,
      actor.scanner?.id ?? null,
      requestId,
      key,
      window,
      threshold,
    ],
  );
}

interface CompletedMiss {
  actor: ScanActor;
  scanId: string;
  claimAt: number;
}

/** Bind the counter to this exact finalized generation, not another completed claim. */
export function completedMissPredicate(input: CompletedMiss): Predicate {
  const { actor, scanId, claimAt } = input;
  return {
    sql: `EXISTS (SELECT 1 FROM scans miss_scan WHERE miss_scan.id=? AND miss_scan.at=?
      AND miss_scan.org_id=? AND miss_scan.mode=? AND miss_scan.actor_key=?
      AND miss_scan.state='done' AND miss_scan.reason='not_found')`,
    params: [scanId, claimAt, actor.orgId, actor.mode, actor.actorKey],
  };
}

/** An eligible miss cannot commit without its counter update. */
export function requireMissIncrementStmt(db: D1Database, eligible: Predicate): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN changes()<>1 AND (${eligible.sql})
    THEN json_extract('[]', '$[scan_effect_incomplete]') ELSE 1 END AS complete`,
    eligible.params,
  );
}

/** The increment crossing the cap cannot commit without its audit row. */
export function requireMissAuditStmt(
  db: D1Database,
  eligible: Predicate,
  key: string,
  window: number,
  threshold: number,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN changes()<>1 AND (${eligible.sql})
    AND EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count=?)
    THEN json_extract('[]', '$[scan_effect_incomplete]') ELSE 1 END AS complete`,
    [...eligible.params, key, window, threshold],
  );
}
