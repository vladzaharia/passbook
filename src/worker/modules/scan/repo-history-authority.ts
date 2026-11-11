import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';
import {
  type HistoryEventSnapshot,
  minimalHistoryAuthorityPredicate,
  packedScanAuthorityPredicate,
} from './repo-session-authority.ts';

/** Full policy-bearing fields still require the original strict pass-read authority. */
export function projectionAuthority(actor: ScanActor, now: number) {
  if (
    actor.invalidScannerScope ||
    actor.role === null ||
    (actor.scanningSession && actor.scanningSession.status !== 'active')
  )
    return { sql: '0', params: [] };
  const strict = actorAuthorityPredicate({
    actor,
    now,
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const actorCheck = packedScanAuthorityPredicate(actor, strict);
  return {
    sql: `(${actorCheck.sql}) AND (s.template_id IS NULL OR EXISTS (
      SELECT 1 FROM templates projected_t WHERE projected_t.id=s.template_id
        AND (projected_t.org_id=s.org_id OR projected_t.org_id IS NULL) AND projected_t.status!='deleted'
        AND ${usableScanTemplateSql({
          templateIdSql: 'projected_t.id',
          orgIdSql: 's.org_id',
          modeSql: 's.mode',
          providerSql: "'apple'",
        })}))`,
    params: actorCheck.params,
  };
}

export function summaryAuthority(
  actor: ScanActor,
  from: number,
  to: number,
  now: number,
  events: readonly HistoryEventSnapshot[],
  csrf: { sql: string; params: readonly SqlValue[] },
  historicalScopeSql: string,
) {
  const minimal = minimalHistoryAuthorityPredicate(actor, now, { scanAlias: 's', events });
  const authority = packedScanAuthorityPredicate(actor, minimal);
  return {
    sql: `s.actor_key=?/* scan-ephemeral-actor-key */ AND s.org_id=? AND s.mode=? AND s.at>=? AND s.at<=?
      AND s.state='done' AND s.action_kind IS NOT 'undo'
      AND ${historicalScopeSql} AND (${authority.sql}) AND (${csrf.sql})`,
    params: [
      actor.actorKey,
      actor.orgId,
      actor.mode,
      from,
      to,
      ...authority.params,
      ...csrf.params,
    ],
  };
}
