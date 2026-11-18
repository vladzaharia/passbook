import { inList } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { importGrant } from './repo-imports.ts';

export interface ResultRow {
  row_no: number;
  action: string;
  state: string;
  result: string | null;
  code: string | null;
  pass_id: string | null;
  external_id: string | null;
  holder_email: string | null;
  problems: string | null;
}

/** Rows that were applied or ended without a pass change, in file order. */
export function resultRows(db: D1Database, importId: string, after: number, limit: number) {
  return all<ResultRow>(
    db,
    `SELECT row_no, action, state, result, code, pass_id, external_id, holder_email, problems
     FROM pass_import_rows WHERE import_id = ? AND row_no > ? ORDER BY row_no LIMIT ?`,
    [importId, after, limit],
  );
}

export interface PassLinkRow {
  id: string;
  org_id: string;
  download_token: string;
  removed_at: number | null;
}

const IN_CHUNK = 50;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

/** The passes of one org (and mode) among `ids`; anything else is absent. */
export async function passLinkRows(
  db: D1Database,
  orgId: string,
  mode: string,
  ids: readonly string[],
): Promise<PassLinkRow[]> {
  const out: PassLinkRow[] = [];
  for (const part of chunks(ids))
    out.push(
      ...(await all<PassLinkRow>(
        db,
        `SELECT id, org_id, download_token, removed_at FROM passes
         WHERE org_id = ? AND mode = ? AND id IN (${part.map(() => '?').join(',')})`,
        [orgId, mode, ...part],
      )),
    );
  return out;
}

/** Created rows after a row number, in file order. */
export function createdRows(db: D1Database, importId: string, after: number, limit: number) {
  return all<{ row_no: number; pass_id: string }>(
    db,
    `SELECT row_no, pass_id FROM pass_import_rows
     WHERE import_id = ? AND result = 'created' AND pass_id IS NOT NULL AND row_no > ?
     ORDER BY row_no LIMIT ?`,
    [importId, after, limit],
  );
}

export interface CreatedPass {
  id: string;
  changed: number;
  mode: string;
  removed_at: number | null;
  scanned: number;
}

/** The current state of created passes of one org; a hard-deleted pass is absent. `changed`: a version other than an automatic rebuild. */
export async function createdPasses(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
): Promise<CreatedPass[]> {
  const out: CreatedPass[] = [];
  for (const part of chunks(ids))
    out.push(
      ...(await all<CreatedPass>(
        db,
        `SELECT p.id, p.mode, p.removed_at,
                EXISTS (SELECT 1 FROM pass_versions v WHERE v.pass_id = p.id AND v.version > 1
                        AND v.cause NOT IN ('template_upgrade', 'user_refresh', 'resign')) AS changed,
                EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = p.id) AS scanned
         FROM passes p WHERE p.org_id = ? AND p.id IN (${part.map(() => '?').join(',')})`,
        [orgId, ...part],
      )),
    );
  return out;
}

/** Created passes that are removed now, counted from the rows so a repeated call never counts twice. */
export async function removedCount(db: D1Database, importId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM pass_import_rows r JOIN passes p ON p.id = r.pass_id
     WHERE r.import_id = ? AND r.result = 'created' AND p.removed_at IS NOT NULL`,
    [importId],
  );
  return row?.n ?? 0;
}

/** The counter and its audit row, in one batch: only for an import that has ended. */
export async function recordRemoval(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  removedTotal: number,
  detail: { removed: number; skipped: number },
): Promise<void> {
  const g = importGrant(ctx, authority, id, {
    state: inList(['done', 'failed', 'stale', 'expired']),
  });
  g.update('pass_imports', { where: { id }, require: 'one', set: { removed: removedTotal } });
  g.audit({
    at: ctx.clock.now(),
    orgId: authority.orgId,
    actorType: authority.kind === 'session' ? 'user' : 'api_key',
    actorId: authority.kind === 'session' ? authority.userId : authority.keyId,
    action: 'pass_import.remove_created',
    targetType: 'pass_import',
    targetId: id,
    requestId: ctx.requestId,
    ipPrefix: null,
    detail: JSON.stringify({ importId: id, ...detail }),
  });
  await g.commit();
}
