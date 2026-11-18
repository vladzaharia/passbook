import { jobGrant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Scope } from '../retention/repo-sweep.ts';

export interface RetentionImport {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  object_key: string | null;
}

const OPEN = ['mapping', 'checking', 'ready', 'stale'];
const ENDED = ['done', 'failed', 'stale', 'expired'];
const TABLES = ['pass_imports', 'pass_import_rows'] as const;
const CODES = { stale: 'IMPORT_STATE', lineage: 'IMPORT_NOT_FOUND' };

const COLUMNS = 'id, org_id, mode, object_key';

/** The platform pass skips the listed orgs; an org pass takes one. */
const scopeSql = (scope: Scope) =>
  scope.kind === 'org'
    ? { sql: 'org_id = ?', param: scope.orgId }
    : {
        sql: 'org_id NOT IN (SELECT value FROM json_each(?))',
        param: JSON.stringify(scope.exclude),
      };

/** Drafts nobody committed, past their expiry, in id order after the cursor. */
export function expiredDrafts(db: D1Database, now: number, after: string, limit: number) {
  return all<RetentionImport>(
    db,
    `SELECT ${COLUMNS} FROM pass_imports
     WHERE state IN ('mapping', 'checking', 'ready', 'stale') AND committed_at IS NULL
       AND expires_at <= ? AND id > ?
     ORDER BY id LIMIT ?`,
    [now, after, limit],
  );
}

/** Ended imports older than `before` whose rows still hold cell values, emails or earlier values. */
export function importsWithPii(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const sc = scopeSql(scope);
  return all<RetentionImport>(
    db,
    `SELECT ${COLUMNS} FROM pass_imports i
     WHERE i.state IN ('done', 'failed', 'stale', 'expired') AND COALESCE(i.finished_at, i.expires_at) < ?
       AND i.id > ? AND i.${sc.sql}
       AND EXISTS (SELECT 1 FROM pass_import_rows r WHERE r.import_id = i.id AND
         (r.input IS NOT NULL OR r.holder_email IS NOT NULL OR r.external_id IS NOT NULL OR r.before IS NOT NULL))
     ORDER BY i.id LIMIT ?`,
    [before, after, sc.param, limit],
  );
}

/** Imports (any end state) older than `before`: their counts go too. */
export function oldImports(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const sc = scopeSql(scope);
  return all<RetentionImport>(
    db,
    `SELECT ${COLUMNS} FROM pass_imports
     WHERE state IN ('done', 'failed', 'stale', 'expired', 'discarded')
       AND COALESCE(finished_at, expires_at) < ? AND id > ? AND ${sc.sql}
     ORDER BY id LIMIT ?`,
    [before, after, sc.param, limit],
  );
}

function retentionGrant(
  ctx: ServiceContext,
  imp: RetentionImport,
  purpose: string,
  states: readonly string[],
  inactiveOk = false,
) {
  return jobGrant(ctx, {
    purpose,
    job: 'pass-import',
    orgId: imp.org_id,
    mode: imp.mode,
    ...(inactiveOk ? { inactiveOk: true as const } : {}),
    target: imp.id,
    tables: TABLES,
    codes: CODES,
    checks: [
      exactlyOne('pass_imports', { id: imp.id, state: inList([...states]) }, undefined, 'stale'),
    ],
  });
}

/** The draft ends `expired` and its unapplied rows go. An import that was ever committed is not a draft: its rows stay. */
export async function expireDraft(ctx: ServiceContext, imp: RetentionImport): Promise<void> {
  const g = retentionGrant(ctx, imp, 'org_mode.job.pass_import.expire', OPEN);
  g.update('pass_imports', { where: { id: imp.id }, require: 'one', set: { state: 'expired' } });
  g.joined('pass_import_rows', {
    where: { import_id: imp.id, result: null },
    delete: true,
  });
  await g.commit();
}

export async function clearPii(ctx: ServiceContext, imp: RetentionImport): Promise<void> {
  const g = retentionGrant(ctx, imp, 'org_mode.job.pass_import.retention_clear', ENDED, true);
  g.joined('pass_import_rows', {
    where: { import_id: imp.id },
    set: { input: null, holder_email: null, external_id: null, before: null },
  });
  await g.commit();
}

/** The import row goes; its rows follow by cascade. */
export async function deleteImport(ctx: ServiceContext, imp: RetentionImport): Promise<void> {
  const g = retentionGrant(
    ctx,
    imp,
    'org_mode.job.pass_import.retention_delete',
    [...ENDED, 'discarded'],
    true,
  );
  g.delete('pass_imports', { where: { id: imp.id }, require: 'one' });
  await g.commit();
}
