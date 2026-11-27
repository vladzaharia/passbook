import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { Override } from './act-override.ts';
import type { ScanActor } from './actor.ts';
import type { AdmissionPlan } from './admission-types.ts';
import type { ActionPassFence } from './repo-act-pass-fence.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { verifiedPresenceCtesSql } from './repo-event-attendance.ts';
import type { ScanEffectSnapshot } from './repo-scan-effect.ts';
import { retainedEventCountSql } from './repo-scan-retention.ts';
import type { ScanEventRow } from './repo-scope.ts';

type Db = D1Database;
type Predicate = { sql: string; params: SqlValue[] };

/** One gate row: a pass, an action and a scope (`''`, `event:<id>` or `day:<date>`). */
export interface GateKey {
  passId: string;
  actionId: string;
  scope: string;
}

/** Which first-scan-wins rule lets the UPSERT through (SA 7.3). */
export type GateRule =
  | { rule: 'once' }
  | { rule: 'cooldown'; cooldownMs: number }
  | { rule: 'always' };

export interface GateAuthority {
  actor: ScanActor;
  pass: Pass;
  passFence: ActionPassFence;
  /** An admission policy can select an event independently of the scanner's scope. */
  event: ScanEventRow | null;
  approvedBy: string | null;
  approvedAuthEpoch: number | null;
  override: Override | null;
  /** Fresh authority and repeat-rule time; the gate transition retains the original claim time. */
  authorityNow?: number;
}

export interface GateClaim extends GateKey {
  orgId: string;
  mode: Mode;
  templateId: string;
  kind: string;
  state: 'in' | 'out' | 'used';
  scanId: string;
  claimAt: number;
  method: string;
  claimEventId: string | null;
  idempotencyKey: string;
  requestHash: string;
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  now: number;
  gate: GateRule;
  capacity?: { eventId: string; max: number; reentry: boolean };
  authority: GateAuthority;
  admission?: AdmissionPlan;
  presenceScope: string;
  effect: ScanEffectSnapshot;
}

/** SQL and params for "this scan holds the gate": the guard on every statement that follows a claim. */
export const wonGate = (g: GateKey, scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scan_gates WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ?)`,
  params: [g.passId, g.actionId, g.scope, scanId],
});

/** Every gate row of a pass (PK prefix): the card reads the door state and cooldowns from these. */
export const gatesOfPassStmt = (db: Db, passId: string): D1PreparedStatement =>
  stmt(db, 'SELECT action_id, scope, state, last_at FROM scan_gates WHERE pass_id = ?', [passId]);

/** Capacity never rejects a pass already in the event's counted population. */
export function capacityFullPredicate(
  orgId: string,
  mode: Mode,
  eventId: string,
  max: number,
  reentry: boolean,
  passId: string,
) {
  const eligible = reentry ? "WHERE verified.state='in'" : '';
  return {
    sql: `(WITH capacity_scope AS MATERIALIZED (
      SELECT ? AS org_id, ? AS mode, ? AS event_id,
        ? AS pass_id, ? AS maximum
    ), ${verifiedPresenceCtesSql('capacity_scope', true)}, totals AS MATERIALIZED (
      SELECT COUNT(DISTINCT verified.pass_id) AS occupied,
        COALESCE(MAX(CASE WHEN verified.pass_id=capacity_scope.pass_id THEN 1 ELSE 0 END),0) AS has_pass
      FROM verified CROSS JOIN capacity_scope ${eligible}
    )
    SELECT totals.occupied
      + ${retainedEventCountSql('capacity_scope.org_id', 'capacity_scope.mode', 'capacity_scope.event_id', reentry)}
      >= capacity_scope.maximum AND NOT totals.has_pass
    FROM capacity_scope CROSS JOIN totals)`,
    params: [orgId, mode, eventId, passId, max],
  };
}

export function credentialTombstonePredicate(
  orgId: string,
  mode: Mode,
  refs: readonly string[],
  credentialKeysetCommitment: string,
): Predicate {
  const check = noCredentialTombstonesSql(
    refs,
    { orgIdSql: '?', modeSql: '?' },
    credentialKeysetCommitment,
  );
  return {
    sql: check.sql,
    params:
      check.sql !== '0' && Array.isArray(refs) && refs.length
        ? [orgId, mode, ...check.params]
        : check.params,
  };
}
