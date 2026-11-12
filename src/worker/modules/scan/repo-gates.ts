import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { Override } from './act-override.ts';
import type { ScanActor } from './actor.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { liveEventPresenceSql } from './repo-event-attendance.ts';
import { scanLedgerCommonScopeSql, scanLedgerSuccessfulCandidateSql } from './repo-feed-scope.ts';
import type { ActionPassFence } from './repo-pass-authority.ts';
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
  adminEventTemplates: boolean;
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

/** The scan that holds the gate now, with who and where, for `previous` and `cooldown`. */
export const gateHolderStmt = (db: Db, g: GateKey): D1PreparedStatement =>
  stmt(
    db,
    `SELECT g.state AS gate_state, g.last_at, g.last_scan_id AS gate_scan_id, g.count AS gate_count,
       s.id AS scan_id, s.at, s.state AS scan_state, s.action_id,
       s.override_of, s.undone_by, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_gates g
     LEFT JOIN scans s ON s.id = g.last_scan_id
     LEFT JOIN scanners sc ON sc.id = s.scanner_id
     LEFT JOIN scan_staff st ON st.id = s.staff_id
     WHERE g.pass_id = ?/* scan-ephemeral-pass-id */ AND g.action_id = ?/* scan-ephemeral-action-id */ AND g.scope = ?/* scan-ephemeral-event-scope */`,
    [g.passId, g.actionId, g.scope],
  );

/** SQL and params for "this scan holds the gate": the guard on every statement that follows a claim. */
export const wonGate = (g: GateKey, scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scan_gates WHERE pass_id = ?/* scan-ephemeral-pass-id */ AND action_id = ?/* scan-ephemeral-action-id */ AND scope = ?/* scan-ephemeral-event-scope */ AND last_scan_id = ?/* scan-ephemeral-scan-id */)`,
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
  const org = '(SELECT org_id FROM capacity_scope)';
  const modeScope = '(SELECT mode FROM capacity_scope)';
  const event = '(SELECT event_id FROM capacity_scope)';
  const witness = `SELECT witness.id AS witness_id FROM scans witness JOIN capacity_scope scope
    ON witness.org_id=scope.org_id AND witness.mode=scope.mode AND witness.event_id=scope.event_id
    WHERE witness.state='done' AND witness.outcome='ok' AND witness.action_kind='check_in'
      AND witness.undone_by IS NULL AND witness.pass_id IS NOT NULL`;
  const eligible = reentry ? "WHERE verified.state='in'" : '';
  return {
    sql: `(WITH capacity_scope AS MATERIALIZED (
      SELECT ? AS org_id, ? AS mode, ?/* scan-ephemeral-event-id */ AS event_id,
        ?/* scan-ephemeral-pass-id */ AS pass_id, ? AS maximum
    ), common AS MATERIALIZED (
      ${witness} AND ${scanLedgerCommonScopeSql('witness')}
    ), candidate AS MATERIALIZED (
      ${witness} AND ${scanLedgerSuccessfulCandidateSql('witness')}
    ), live AS MATERIALIZED (
      ${liveEventPresenceSql(org, modeScope, event, '1', true, true)}
    ), verified AS MATERIALIZED (
      SELECT live.pass_id,live.state FROM live
      JOIN common USING(witness_id) JOIN candidate USING(witness_id)
    ), totals AS MATERIALIZED (
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
