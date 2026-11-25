import { type Grant, grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond, not } from '../../platform/authority-cond.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { scanActorChecks, scanCapabilityChecks, scanPrincipal } from './authority-checks.ts';
import type { ScanActor } from './guard.ts';
import { credentialRefChecks } from './repo-scan-checks.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { onlyApproverCheck } from './repo-staff.ts';
import { tagBindingCheck } from './repo-tags-resolve.ts';
import { type ScanPassFacts, scanPassChecks } from './scan-pass-checks.ts';

/** A manager whose PIN was verified. `sole`: they approved their own request as the only approver (re-counted at commit). */
export interface ScanApprover {
  id: string;
  authEpoch: number;
  deskOk?: boolean;
  sole?: { scanId: string };
}

export interface ScanWriteInput {
  purpose: `org_mode.scan.${'claim' | 'check_in' | 'value' | 'held' | 'stop' | 'undo' | 'tag.bind' | 'tag.unbind' | 'tag.enroll' | 'hold' | 'roll_call' | 'note'}`;
  now: number;
  /** The operation's event when it is not the actor's. */
  event?: ScanEventRow | null;
  /** Only this template's membership is checked. */
  templateId?: string;
  pass?: { id: string; facts: ScanPassFacts };
  /** A manager whose PIN was verified for this action. */
  approver?: ScanApprover | null;
  /** Held: the answer shown names this gate holder and must still be true. */
  holder?: { passId: string; actionId: string; scope: string; lastScanId: string } | null;
  /** None of the presented credential's references may be retired by a transfer in this mode. */
  credentialRefs?: readonly string[];
  /** Further checks of the operation itself (a value action's pass write adds its row version). */
  checks?: readonly Check[];
  target?: string;
  codes?: DenialOptions['codes'];
  /** Mark as out only (C16): a paused session still lets the desk clear who is inside; its config epoch is still compared. */
  pausedSession?: boolean;
  /** Unguarded tables the grant's parts write. */
  tables?: string[];
}

/**
 * The one grant every scan write goes through: the actor's epochs, the pass's lineage, the tag and
 * binding a tag read chose it by and, when present, the approving manager. Refusals keep the device paired except `actor` (a re-pair).
 */
export function scanWriteGrant(ctx: ServiceContext, actor: ScanActor, i: ScanWriteInput): Grant {
  const templateId = i.templateId ?? i.pass?.facts.pass.templateId;
  const g = grant(ctx, {
    purpose: i.purpose,
    principal: scanPrincipal(actor),
    ...(i.target ? { target: i.target } : {}),
    checks: [
      ...scanCapabilityChecks(actor),
      ...scanActorChecks(actor, {
        now: i.now,
        ...(i.pausedSession ? { read: { pausedSession: true } } : {}),
        ...(i.event === undefined ? {} : { event: i.event }),
        ...(templateId ? { templateId } : {}),
      }),
      ...(i.pass ? scanPassChecks(i.pass.id, i.pass.facts) : []),
      ...credentialRefChecks(i.credentialRefs),
      ...(actor.tag ? [tagBindingCheck(actor.tag)] : []),
      ...(i.checks ?? []),
      ...(i.approver
        ? [
            rowIs(
              'scan_staff',
              i.approver.id,
              {
                // A Desk approver is pinned as Desk: the session allowed it, and a role change bumps `auth_epoch`.
                role: i.approver.deskOk ? 'desk' : 'manager',
                disabled_at: null,
                auth_epoch: i.approver.authEpoch,
              },
              'staff',
            ),
          ]
        : []),
      ...(i.approver?.sole
        ? [onlyApproverCheck(actor.orgId, i.approver.id, actor.settings.approvals === 'desk')]
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
  // The audit row commits with the scan: nothing records the approval without the grant holding.
  if (i.approver?.sole)
    g.add(
      grantedAudit(g, ctx, {
        orgId: actor.orgId,
        actorType: actor.scanner ? 'scanner' : 'system',
        actorId: actor.scanner?.id ?? null,
        action: 'scan.approved_alone',
        targetType: 'scan',
        targetId: i.approver.sole.scanId,
        detail: {
          kind: 'sole',
          staffId: i.approver.id,
          role: i.approver.deskOk ? 'desk' : 'manager',
        },
      }),
    );
  return g;
}

/** Every table a scan write grant may name; each purpose lists what it writes. */
export const SCAN_STOP_TABLES = ['scans', 'pass_events', 'scan_retention_proofs'];
/** A held or committed scan also returns its verified PIN's attempt (`counters`). */
export const SCAN_HELD_TABLES = [...SCAN_STOP_TABLES, 'counters'];
export const SCAN_COMMIT_TABLES = [
  ...SCAN_HELD_TABLES,
  'scan_gates',
  'scan_presence',
  'scan_place_revs',
];

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
 * Side statements were written for the old fences: they read the tenant from their JSON. In a grant the tenant is the grant's: `{org}` and `{mode}` replace those reads,
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
