import { grant, grantedBatch } from '../../platform/authority.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PlatformSessionAuthority } from './access.ts';
import type { TemplateRow } from './repo.ts';
import { assignable } from './repo-grant-checks.ts';
import { templateGrant } from './repo-grants.ts';

export async function hasAssignmentHistory(db: D1Database, id: string): Promise<boolean> {
  const history = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM template_candidates WHERE template_id = ?)
       OR EXISTS (SELECT 1 FROM template_releases WHERE template_id = ?)`,
    [id, id],
  );
  return !!history;
}

/** Events, scanners and scanning sessions that point at the template (they would reference another org's). */
export async function hasScanReferences(db: D1Database, id: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM scan_event_templates WHERE template_id = ?)
       OR EXISTS (SELECT 1 FROM scanner_templates WHERE template_id = ?)
       OR EXISTS (SELECT 1 FROM scanning_sessions ss, json_each(ss.accepts, '$.templateIds') j
         WHERE ss.accepts IS NOT NULL AND j.value = ?)`,
    [id, id, id],
  );
  return !!row;
}

const CODES = {
  lineage: 'TEMPLATE_CONFLICT',
  stale: 'TEMPLATE_CONFLICT',
  config: 'TEMPLATE_CONFLICT',
};

/**
 * Moves a template to another org (or to none). Only a platform grant sets `org_id`. Check-only platform
 * grants name the current and destination org, so each must be active, without the admin being a
 * member of either. A reference from the old org (event, scanner, session) refuses the move.
 */
export async function assignTemplateOrg(
  ctx: ServiceContext,
  id: string,
  row: TemplateRow,
  orgId: string | null,
  authority: PlatformSessionAuthority,
  now: number,
): Promise<boolean> {
  const principal = (target: string) =>
    ({
      kind: 'platform',
      userId: authority.userId,
      sessionIdHash: authority.sessionId,
      orgId: target,
    }) as const;
  const orgs = [...new Set([row.orgId, orgId].filter((o): o is string => o !== null))];
  const touched = orgs.map((target) =>
    grant(ctx, {
      purpose: 'platform.template.assign_check',
      principal: principal(target),
      codes: CODES,
    }),
  );
  const writer = templateGrant(ctx, authority, 'assign', {
    target: id,
    codes: CODES,
    checks: [assignable(id, orgId)],
  });
  writer.update('templates', {
    set: { org_id: orgId, updated_at: maxNow(now) },
    where: { id, org_id: row.orgId, origin: row.origin, status: row.status },
    require: 'one',
    returning: ['id'],
  });
  try {
    const results = await grantedBatch(ctx.env.DB, [...touched, writer]);
    return (results.at(-1)?.[0]?.results.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ConflictError) return false;
    throw error;
  }
}
