import type { SqlValue } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { eventMatchSql } from './repo-event-match.ts';
import type { ActionPassFence } from './repo-pass-authority.ts';
import { evaluatedPolicyPredicate, passPredicate } from './repo-pass-predicates.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';

export type { VerifiedLedgerBinding } from './repo-action-authority-ledger.ts';
export { ledgerAuthorityPredicate } from './repo-action-authority-ledger.ts';

type Predicate = { sql: string; params: SqlValue[] };

/** Pack only nonsecret metadata; marked scalars remain independent D1 binds. */
export function packedPredicate(sql: string, params: SqlValue[]): Predicate {
  return packScanPredicate(sql, params, 'authority_snapshot') ?? { sql: '0', params: [] };
}

/** Keep each authority component in a separate join condition to bound D1 expression depth. */
function packedActionPredicate(parts: readonly string[], params: SqlValue[]): Predicate {
  const boundary = '/* scan-action-authority-part */';
  const packed = packedPredicate(parts.join(boundary), params);
  if (packed.sql === '0') return packed;
  const prefix = 'EXISTS (SELECT 1 FROM (SELECT json(?) AS data) authority_snapshot WHERE ';
  if (!packed.sql.startsWith(prefix) || !packed.sql.endsWith(')')) return { sql: '0', params: [] };
  const expressions = packed.sql.slice(prefix.length, -1).split(boundary);
  if (expressions.length !== parts.length) return { sql: '0', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM (SELECT json(?) AS data) authority_snapshot
      ${expressions.map((expression) => `JOIN (SELECT 1) ON (${expression})`).join(' ')})`,
    params: packed.params,
  };
}

/** Apply the canonical event filter to the same pass row used by an authority fence. */
export function eventPassPredicate(actor: ScanActor, event: ScanEventRow | null): Predicate {
  const events = [actor.event, event].filter(
    (value, index, list): value is ScanEventRow =>
      value != null && list.findIndex((other) => other?.id === value.id) === index,
  );
  return {
    sql:
      events
        .map(
          () => `EXISTS (SELECT 1 FROM scan_events event_filter
      WHERE event_filter.id=?/* scan-ephemeral-event-id */ AND event_filter.org_id=p.org_id AND event_filter.mode=p.mode
        AND ${eventMatchSql('event_filter', 'p')})`,
        )
        .join(' AND ') || '1',
    params: events.map((selected) => selected.id),
  };
}

export interface StopAuthority {
  actor: ScanActor;
  event: ScanEventRow | null;
  templateId?: string;
  adminEventTemplates: boolean;
  passFence: ActionPassFence | null;
  approvedBy?: string | null;
  approvedAuthEpoch?: number | null;
}

/** Mutations require commit-compatible authority. */
export function stopAuthorityPredicate(
  input: StopAuthority,
  pass: Pass | null,
  now: number,
  actionDirect = false,
): Predicate {
  return actionAuthorityPredicate(input, pass, now, 'commit', actionDirect);
}

/** A receipt may project only under current read policy and current actor authority. */
export function replayAuthorityPredicate(
  input: StopAuthority,
  pass: Pass | null,
  now: number,
): Predicate {
  return actionAuthorityPredicate(input, pass, now, 'read');
}

function actionAuthorityPredicate(
  input: StopAuthority,
  pass: Pass | null,
  now: number,
  purpose: 'read' | 'commit',
  actionDirect = false,
): Predicate {
  if (input.actor.scanner && input.actor.scanner.deviceRole !== 'scan')
    return { sql: '0', params: [] };
  if (
    input.actor.principal === 'admin' &&
    input.actor.tenantAuthority?.capability !== 'passes:operate'
  )
    return { sql: '0', params: [] };
  const actor = actorAuthorityPredicate({
    actor: input.actor,
    now,
    event: input.event,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    adminEventTemplates: input.adminEventTemplates,
  });
  const parts = [`(${actor.sql})`];
  const params = [...actor.params];
  if (pass) {
    if (
      !input.passFence ||
      pass.orgId !== input.actor.orgId ||
      typeof input.passFence.orgRevision !== 'number' ||
      typeof input.passFence.templateRevision !== 'number'
    )
      return { sql: '0', params: [] };
    const snapshot = passPredicate(pass, input.passFence.connectionGeneration);
    const policy = evaluatedPolicyPredicate(
      input.passFence.activeTemplateVersion,
      input.passFence.orgRevision,
      input.passFence.templateRevision,
      input.passFence,
      purpose,
      now,
      input.passFence.walletStatus,
    );
    const event = eventPassPredicate(input.actor, input.event);
    parts.push(`EXISTS (SELECT 1 FROM passes p WHERE ${snapshot.sql}
      AND (SELECT rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id) IS ?/* scan-ephemeral-check-in-rules */
      AND ${policy.sql} AND (${event.sql}))`);
    params.push(...snapshot.params, input.passFence.rules, ...policy.params, ...event.params);
  }
  if (input.approvedBy) {
    parts.push(`EXISTS (SELECT 1 FROM scan_staff st WHERE st.id=?/* scan-ephemeral-approver-id */ AND st.org_id=?
      AND st.disabled_at IS NULL AND st.role='manager' AND st.auth_epoch=?)`);
    params.push(input.approvedBy, input.actor.orgId, input.approvedAuthEpoch ?? null);
  }
  const sql = parts.join(' AND ');
  const packed = packedActionPredicate(parts, params);
  if (
    !actionDirect ||
    packed.sql === '0' ||
    params.length > 90 ||
    !scanSecretSlots(sql, params.length)
  )
    return packed;
  // Singleton join conditions keep independent checks shallow and map NULL to false.
  const direct = `EXISTS (SELECT 1 FROM (SELECT 1) action_authority_direct
    ${parts.map((part) => `JOIN (SELECT 1) ON (${part})`).join(' ')})`;
  const encoder = new TextEncoder();
  if (
    encoder.encode(direct).byteLength > 90_000 ||
    params.some(
      (value) =>
        (typeof value === 'string'
          ? encoder.encode(value).byteLength
          : value instanceof ArrayBuffer
            ? value.byteLength
            : value instanceof Uint8Array
              ? value.byteLength
              : 0) > 1_900_000,
    )
  )
    return packed;
  return { sql: direct, params };
}
