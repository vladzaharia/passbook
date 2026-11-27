import type { PassMatch } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, prefixMatch } from '../../platform/db.ts';
import { inputMatchSql } from './repo-input-match.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow, type PassStatus } from './repo-map.ts';

export interface PassListFilter {
  orgId?: string | null;
  /** Any of these organizations (a list across organizations). */
  orgIds?: string[];
  /** The caller's mode; admin and API lists always set it. */
  mode?: Mode;
  templateId?: string;
  /** Any of these templates. */
  templateIds?: string[];
  connectionId?: string;
  /** Passes a pass import (of the same organization) created or updated. */
  importId?: string;
  /** `voided` leaves out removed passes; `removed` is those alone. */
  status?: PassStatus | 'removed';
  holderEmail?: string;
  holderState?: 'unassigned' | 'waiting' | 'owned';
  onDevice?: boolean;
  /** Only passes with no completed scan since this time (ms). */
  noScanSince?: number;
  /** Only passes whose inputs satisfy every clause. */
  match?: PassMatch;
  /** Passes on this template version or on a version with the same build. */
  version?: string;
  /** Skips passes removed from Wallet. */
  excludeRemoved?: boolean;
  q?: string;
  /** Exact match. */
  externalId?: string;
  cursor?: string | undefined;
  limit: number;
}

const HOLDER_STATE_SQL = {
  unassigned: 'holder_email IS NULL AND owner_user_id IS NULL',
  waiting: 'holder_email IS NOT NULL AND owner_user_id IS NULL',
  owned: 'owner_user_id IS NOT NULL',
} as const;

/** The WHERE clauses and parameters for a filter, shared by lists and counts. */
export function passFilterSql(filter: PassListFilter): {
  where: string[];
  params: (string | number)[];
} {
  const where: string[] = ['deleted_at IS NULL', 'test_data_quarantined = 0'];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (filter.orgId) add('org_id = ?', filter.orgId);
  if (filter.orgIds)
    add('org_id IN (SELECT value FROM json_each(?))', JSON.stringify(filter.orgIds));
  if (filter.mode) add('mode = ?', filter.mode);
  if (filter.templateId) add('template_id = ?', filter.templateId);
  if (filter.templateIds?.length)
    add(`template_id IN (${filter.templateIds.map(() => '?').join(', ')})`, ...filter.templateIds);
  if (filter.connectionId) add('connection_id = ?', filter.connectionId);
  if (filter.importId)
    add(
      `EXISTS (SELECT 1 FROM pass_import_rows r JOIN pass_imports i ON i.id = r.import_id
        WHERE r.pass_id = passes.id AND r.import_id = ? AND r.result IN ('created', 'updated') AND i.org_id = passes.org_id)`,
      filter.importId,
    );
  if (filter.status === 'removed') where.push('removed_at IS NOT NULL');
  else if (filter.status) {
    add('status = ?', filter.status);
    if (filter.status === 'voided') where.push('removed_at IS NULL');
  }
  if (filter.holderEmail) add('holder_email = ?', filter.holderEmail);
  if (filter.holderState) where.push(HOLDER_STATE_SQL[filter.holderState]);
  if (filter.onDevice !== undefined)
    where.push(
      `${filter.onDevice ? '' : 'NOT '}EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id)`,
    );
  if (filter.noScanSince !== undefined)
    add(
      `NOT EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = passes.id
        AND s.org_id = passes.org_id AND s.mode = passes.mode AND s.state = 'done' AND s.at >= ?)`,
      filter.noScanSince,
    );
  if (filter.externalId) add('external_id = ?', filter.externalId);
  if (filter.match) {
    const m = inputMatchSql(filter.match, 'passes');
    add(m.sql, ...m.params);
  }
  if (filter.version)
    add(
      `(template_version = ? OR EXISTS (SELECT 1 FROM template_versions a
        JOIN template_versions b ON b.template_id = a.template_id AND b.build_key = a.build_key
        WHERE a.template_id = passes.template_id AND a.version = passes.template_version
          AND b.version = ? AND a.build_key IS NOT NULL))`,
      filter.version,
      filter.version,
    );
  if (filter.excludeRemoved) where.push('removed_at IS NULL');
  if (filter.cursor) add('id < ?', filter.cursor);
  const q = filter.q?.trim();
  if (q) {
    // One indexed prefix lookup per column (NOCASE indexes), merged by id: an OR of LIKEs scans.
    const matches = ['display_title', 'display_subtitle', 'external_id', 'holder_email'].map(
      (column) => prefixMatch(column, q),
    );
    add(
      `id IN (${[
        ...matches.map((m) => `SELECT id FROM passes WHERE ${m.sql}`),
        'SELECT id FROM passes WHERE serial = ?',
      ].join(' UNION ')})`,
      ...matches.flatMap((m) => m.params as (string | number)[]),
      q,
    );
  }
  return { where, params };
}

/** Passes a list filter matches, ignoring the cursor and limit. */
export async function countPasses(db: D1Database, filter: PassListFilter): Promise<number> {
  const { where, params } = passFilterSql({ ...filter, cursor: undefined });
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes WHERE ${where.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = passes.id AND t.state = 'pending')`,
    params,
  );
  return row?.n ?? 0;
}

/** The page statement of a list: one more row than the limit, so the caller can tell there is a next page. */
export function listPassesSql(filter: PassListFilter): {
  sql: string;
  params: (string | number)[];
} {
  const { where, params } = passFilterSql(filter);
  return {
    sql: `${PASS_SELECT} WHERE ${where.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = passes.id AND t.state = 'pending')
      ORDER BY id DESC LIMIT ?`,
    params: [...params, filter.limit + 1],
  };
}

/** Newest first by id (UUIDv7). Search is prefix-only on display fields, exact on serial. */
export async function listPasses(
  db: D1Database,
  filter: PassListFilter,
): Promise<{ items: Pass[]; nextCursor: string | null }> {
  const { sql, params } = listPassesSql(filter);
  const rows = await all<PassDbRow>(db, sql, params);
  const page = rows.slice(0, filter.limit).map(mapPass);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
}

/** The templates the org's passes of this mode use. */
export async function orgTemplateIds(db: D1Database, orgId: string, mode: Mode): Promise<string[]> {
  const rows = await all<{ template_id: string }>(
    db,
    'SELECT DISTINCT template_id FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL',
    [orgId, mode],
  );
  return rows.map((r) => r.template_id);
}
