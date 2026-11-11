import { type Grant, grant } from '../../platform/authority.ts';
import { exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond, not, tenantCheck } from '../../platform/authority-cond.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { type GrantPart, readPart, writePart } from '../../platform/authority-include.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import type { ScanActor } from './guard.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { capturedStatement } from './scan-capture.ts';
import { type ScanPassFacts, scanPassChecks } from './scan-pass-checks.ts';

export interface ScanWriteInput {
  purpose: `org_mode.scan.${'claim' | 'check_in' | 'held' | 'stop' | 'undo'}`;
  now: number;
  /** The operation's event when it is not the actor's. */
  event?: ScanEventRow | null;
  /** Only this template's membership is checked. */
  templateId?: string;
  pass?: { id: string; facts: ScanPassFacts };
  /** A manager whose PIN was verified for this action. */
  approver?: { id: string; authEpoch: number } | null;
  /** Held: the answer shown names this gate holder and must still be true. */
  holder?: { passId: string; actionId: string; scope: string; lastScanId: string } | null;
  /** A passless miss: none of the presented credential's references may be retired by a transfer. */
  credentialRefs?: { current: readonly string[]; other: readonly string[] };
  target?: string;
  codes?: DenialOptions['codes'];
  /** Unguarded tables the grant's parts write. */
  tables?: string[];
}

/**
 * The one grant every scan write goes through: the actor's epochs, the pass's lineage and, when
 * present, the approving manager. Refusals keep the device paired except `actor` (a re-pair).
 */
export function scanWriteGrant(ctx: ServiceContext, actor: ScanActor, i: ScanWriteInput): Grant {
  const templateId = i.templateId ?? i.pass?.facts.pass.templateId;
  return grant(ctx, {
    purpose: i.purpose,
    principal: scanPrincipal(actor),
    ...(i.target ? { target: i.target } : {}),
    checks: [
      ...scanActorChecks(actor, {
        now: i.now,
        ...(i.event === undefined ? {} : { event: i.event }),
        ...(templateId ? { templateId } : {}),
      }),
      ...(i.pass ? scanPassChecks(i.pass.id, i.pass.facts) : []),
      ...credentialChecks(i.credentialRefs),
      ...(i.approver
        ? [
            rowIs(
              'scan_staff',
              i.approver.id,
              { role: 'manager', disabled_at: null, auth_epoch: i.approver.authEpoch },
              'staff',
            ),
          ]
        : []),
      ...(i.holder
        ? [
            exactlyOne(
              'scan_gates',
              {
                pass_id: i.holder.passId,
                action_id: i.holder.actionId,
                scope: i.holder.scope,
                last_scan_id: i.holder.lastScanId,
              },
              undefined,
              'stale',
            ),
          ]
        : []),
    ],
    ...(i.tables ? { tables: i.tables } : {}),
    codes: {
      lineage: 'SCAN_PASS_CHANGED',
      config: 'SCAN_CONFIG_CHANGED',
      staff: 'SCAN_STAFF_CHANGED',
      stale: 'SCAN_IN_PROGRESS',
      ...i.codes,
    },
  });
}

function credentialChecks(refs: ScanWriteInput['credentialRefs']) {
  const sql = (mode: string) => `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones x
    WHERE x.org_id = {org} AND x.mode = ${mode} AND x.credential_hash IN (SELECT value FROM json_each(?)))`;
  return [
    ...(refs?.current.length
      ? [tenantCheck('lineage', sql('{mode}'), [JSON.stringify(refs.current)])]
      : []),
    ...(refs?.other.length
      ? [
          tenantCheck('lineage', sql("(CASE {mode} WHEN 'live' THEN 'test' ELSE 'live' END)"), [
            JSON.stringify(refs.other),
          ]),
        ]
      : []),
  ];
}

/** Every table a scan write grant may name; each purpose lists what it writes. */
export const SCAN_HELD_TABLES = ['scans', 'pass_events', 'scan_retention_proofs'];
export const SCAN_COMMIT_TABLES = [...SCAN_HELD_TABLES, 'scan_gates', 'scan_presence'];
export const SCAN_STOP_TABLES = [...SCAN_HELD_TABLES];

/** "This scan took the gate." */
export const wonGate = (
  gate: { passId: string; actionId: string; scope: string },
  scanId: string,
) =>
  exists('scan_gates', {
    pass_id: gate.passId,
    action_id: gate.actionId,
    scope: gate.scope,
    last_scan_id: scanId,
  });

export const scanIs = (scanId: string, where: Record<string, string | number | null> = {}) =>
  exists('scans', { id: scanId, ...where });

/** A capacity-bounded event still has room. The predicate is the one the preflight read, run in the statement. */
export function capacityOpen(full: {
  sql: string;
  params: readonly (string | number)[];
}): GrantCond {
  return {
    render: (b) => {
      let at = 0;
      const sql = full.sql.replace(/\?/g, () => b.bind(full.params[at++]));
      return `NOT COALESCE((${sql}), 0)`;
    },
  };
}

export { not };

/**
 * Side statements were written for the old fences: they carry `scan-ephemeral` comments and read the
 * tenant from their JSON. In a grant the tenant is the grant's: `{org}` and `{mode}` replace those reads,
 * so a part can never name another tenant.
 */
export function partSql(sql: string): string {
  return sql
    .replace(/\/\*.*?\*\//gs, '')
    .replace(/json_extract\(input\.j,'\$\.(?:proof\.|scan\.|event\.)?(?:orgId|org_id)'\)/g, '{org}')
    .replace(/json_extract\(input\.j,'\$\.(?:proof\.|scan\.|event\.)?mode'\)/g, '{mode}')
    .replace(/(\w+)\.org_id\s*=\s*\w+\.org_id/g, '$1.org_id={org}')
    .replace(/(\w+)\.mode\s*=\s*\w+\.mode/g, '$1.mode={mode}');
}

function capturedPart(statement: D1PreparedStatement, what: string): GrantPart {
  const seen = capturedStatement(statement);
  if (!seen)
    throw new AuthorityError('GRANT_FOREIGN_STATEMENT', `A ${what} statement was not captured.`);
  return writePart(`${partSql(seen.sql)} AND {grant}`, seen.params);
}

/** The retention proof row commits in the grant's batch, right after its ledger row (it inserts only when that row did). */
export const retentionPart = (statement: D1PreparedStatement): GrantPart =>
  capturedPart(statement, 'retention');

/** The current holder of a gate, named for a heads-up that lost the race. */
export const holderPart = (gate: { passId: string; actionId: string; scope: string }): GrantPart =>
  readPart(
    `SELECT g.state AS gate_state, g.last_at, g.last_scan_id AS gate_scan_id, g.count AS gate_count,
       s.id AS scan_id, s.at, s.state AS scan_state, s.action_id, s.scanner_id, s.staff_id,
       s.override_of, s.undone_by, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_gates g LEFT JOIN scans s ON s.id = g.last_scan_id AND s.org_id = {org}
     LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = {org}
     LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = {org}
     WHERE g.pass_id = ? AND g.action_id = ? AND g.scope = ? AND g.org_id = {org}`,
    [gate.passId, gate.actionId, gate.scope],
  );

/** The scan closed (any outcome): what post-commit work for a heads-up is gated on. */
export const doneScanPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done')`,
  params: [scanId],
});

/** A scan row is closed with this outcome: what the post-commit work (counts, display, photo) is gated on. */
export const doneOkPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done' AND q.outcome = 'ok')`,
  params: [scanId],
});

/**
 * A PIN attempt is returned after the scan commits, or after a classified refusal, as its own counter
 * write outside any grant (counters hold no authority). A failed refund is logged and never fails the scan.
 */
export async function refundPin(
  ctx: ServiceContext,
  reservation: { refundStatements(): D1PreparedStatement[]; markRefunded(): void } | null,
): Promise<void> {
  if (!reservation) return;
  try {
    await ctx.env.DB.batch(reservation.refundStatements());
    reservation.markRefunded();
  } catch (error) {
    ctx.log.error('scan.pin_refund_failed', {
      code: 'SCAN_PIN_REFUND_FAILED',
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}
