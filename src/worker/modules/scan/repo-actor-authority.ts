import { first, type SqlValue } from '../../platform/db.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { type ScanActor, tenantScanRole } from './actor.ts';
import {
  appendEventTemplateProofs,
  appendLegacyAdminSession,
  appendLegacyEvent,
} from './repo-actor-event-authority.ts';
import { appendScannerAuthority, CSRF_PROOF } from './repo-actor-scanner-authority.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';
import { scanConjunction, scanSecretSlots } from './repo-secret-binds.ts';
import { ROLE_RANK } from './rules.ts';
import { scanEpochsOf } from './scan-epochs.ts';

type Db = D1Database;
type Predicate = { sql: string; params: SqlValue[] };

export interface ActorAuthority {
  actor: ScanActor;
  now: number;
  event: ScanEventRow | null;
  templateId?: string;
  /** Monitor projections can remain staffless without granting scanning authority. */
  allowStafflessScreen?: boolean;
  adminEventTemplates: boolean;
}

/** Build the original live actor checks in their parameter order. */
function actorAuthorityParts(input: ActorAuthority): { parts: string[]; params: SqlValue[] } {
  const { actor, now, event, templateId, adminEventTemplates } = input;
  const parts = [`EXISTS (SELECT 1 FROM orgs o WHERE o.id=? AND o.status='active')`];
  const params: SqlValue[] = [actor.orgId];
  if (
    (actor.role === null &&
      !(input.allowStafflessScreen && actor.scanner?.deviceRole === 'monitor')) ||
    actor.invalidScannerScope ||
    (actor.scanningSession && actor.scanningSession.status !== 'active')
  )
    parts.push('0');

  const epochs = scanEpochsOf(actor);
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    const authorizedRole = authority?.kind === 'session' ? tenantScanRole(authority) : null;
    if (
      authority?.kind !== 'session' ||
      authority.orgId !== actor.orgId ||
      authority.userId !== actor.actor.id ||
      actor.actor.type !== 'user' ||
      authority.sessionId !== actor.platformSessionId ||
      authority.mode !== actor.mode ||
      !authorizedRole ||
      actor.role === null ||
      !Object.hasOwn(ROLE_RANK, actor.role) ||
      ROLE_RANK[actor.role] > ROLE_RANK[authorizedRole] ||
      (authority.capability !== 'scanning:read' &&
        authority.capability !== 'scanning:manage' &&
        authority.capability !== 'passes:operate') ||
      authority.sessionExpiresAt <= now ||
      !CSRF_PROOF.test(authority.sessionCsrfProof ?? '')
    ) {
      parts.push('0');
    } else {
      parts.push(tenantPassAuthoritySql(authority));
      params.push(...tenantPassAuthorityParams(authority, now));
      if (epochs) {
        // Lifetime, secret and roles of a session cannot change (0047), so only liveness is read.
        parts.push(`EXISTS (SELECT 1 FROM sessions actor_session
          WHERE actor_session.id_hash=?/* scan-ephemeral-session-id-hash */ AND actor_session.user_id=?
            AND actor_session.revoked_at IS NULL AND actor_session.expires_at>? AND actor_session.idle_expires_at>?)`);
        params.push(authority.sessionId, authority.userId, now, now);
      } else if (!appendLegacyAdminSession(authority, parts, params)) parts.push('0');
    }
  }

  const scanner = actor.scanner;
  appendScannerAuthority(actor, scanner, now, templateId, parts, params);

  for (const e of [actor.event, event].filter(
    (value, index, list): value is ScanEventRow =>
      value !== null && list.findIndex((other) => other?.id === value.id) === index,
  )) {
    const epoch = epochs?.events[e.id];
    if (!epochs) {
      appendLegacyEvent(e, actor.orgId, actor.mode, parts, params);
    } else if (epoch !== undefined) {
      parts.push(`EXISTS (SELECT 1 FROM scan_events e WHERE e.id=?/* scan-ephemeral-event-id */
        AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL AND e.config_epoch=?)`);
      params.push(e.id, actor.orgId, actor.mode, epoch);
      if (!templateId) appendEventTemplateProofs(e.id, actor.orgId, actor.mode, parts, params);
    } else if (e === actor.event && (actor.scanner?.eventId || actor.scanningSession)) {
      // The event a scanner or session pins must have been captured with it.
      parts.push('0');
    } else {
      // An event the guard did not capture (the pass's own event): its configuration columns,
      // never its stamp. WP5b captures its epoch and drops this branch.
      parts.push(`EXISTS (SELECT 1 FROM scan_events e WHERE e.id=?/* scan-ephemeral-event-id */
        AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL
        AND e.match_input IS ?/* scan-ephemeral-event-match-input */
        AND e.match_values IS ?/* scan-ephemeral-event-match-values */
        AND e.opens_at=? AND e.closes_at=?
        AND e.time_zone=?/* scan-ephemeral-event-time-zone */ AND e.capacity IS ? AND e.reentry=?)`);
      params.push(
        e.id,
        actor.orgId,
        actor.mode,
        e.matchInput,
        e.matchValues,
        e.opensAt,
        e.closesAt,
        e.timeZone,
        e.capacity,
        e.reentry,
      );
      if (!templateId) appendEventTemplateProofs(e.id, actor.orgId, actor.mode, parts, params);
    }
  }
  if (actor.event && (scanner || adminEventTemplates)) {
    parts.push(`(SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=?/* scan-ephemeral-event-id */)=?
      AND NOT EXISTS (SELECT 1 FROM scan_event_templates et WHERE et.event_id=?/* scan-ephemeral-event-id */
        AND et.template_id NOT IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`);
    params.push(
      actor.event.id,
      actor.templateIds.length,
      actor.event.id,
      JSON.stringify(actor.templateIds),
    );
    if (templateId) {
      parts.push(`EXISTS (SELECT 1 FROM scan_event_templates et
        WHERE et.event_id=?/* scan-ephemeral-event-id */ AND et.template_id=?/* scan-ephemeral-template-id */)`);
      params.push(actor.event.id, templateId);
    }
  }
  if (templateId) {
    parts.push(`COALESCE((WITH actor_template_scope AS MATERIALIZED (SELECT ? AS mode, ? AS org_id),
      actor_template AS MATERIALIZED (
        SELECT t.id FROM templates t CROSS JOIN actor_template_scope scope
        WHERE t.id=?/* scan-ephemeral-template-id */
          AND (t.org_id=scope.org_id OR t.org_id IS NULL) AND t.status!='deleted'
      )
      SELECT ${usableScanTemplateSql({
        templateIdSql: 't.id',
        orgIdSql: 'scope.org_id',
        modeSql: 'scope.mode',
        providerSql: "'apple'",
      })} FROM actor_template t CROSS JOIN actor_template_scope scope),0)`);
    params.push(actor.mode, actor.orgId, templateId);
  }
  return { parts, params };
}

/** The same live actor checks are used for pass-bearing responses and for the atomic gate. */
export function actorAuthorityPredicate(input: ActorAuthority): Predicate {
  const { parts, params } = actorAuthorityParts(input);
  return { sql: scanConjunction(parts), params };
}

/** Evaluate these conjuncts in one D1 batch when a single SELECT would be too deep. */
export function actorAuthorityPredicates(input: ActorAuthority): Predicate[] {
  const { parts, params } = actorAuthorityParts(input);
  const joined = parts.join(' AND ');
  // Preserve the original single-output bind and payload limits before splitting.
  if (boundOutputPredicate({ sql: joined, params }).sql === '0') return [{ sql: '0', params: [] }];
  const slots = scanSecretSlots(joined, params.length);
  if (!slots) return [{ sql: '0', params: [] }];
  const checks: Predicate[] = [];
  let start = 0;
  let first = 0;
  for (const sql of parts) {
    const end = start + sql.length;
    let last = first;
    while (last < slots.length && (slots[last]?.offset ?? end) < end) last++;
    checks.push({ sql, params: params.slice(first, last) });
    first = last;
    start = end + ' AND '.length;
  }
  return first === params.length ? checks : [{ sql: '0', params: [] }];
}

/** Used before returning a pass-bearing result that does not claim a gate. */
export async function actorAuthorityCurrent(db: Db, input: ActorAuthority): Promise<boolean> {
  const authority = actorAuthorityPredicate(input);
  const row = await first<{ valid: number }>(
    db,
    `SELECT (${authority.sql}) AS valid`,
    authority.params,
  );
  return row?.valid === 1;
}
