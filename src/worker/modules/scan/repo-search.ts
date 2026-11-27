import { exactStmt, prefixMatch, type SqlValue } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import type { ScanActor } from './actor.ts';
import { RACE_SEARCH_PAGE } from './race-tags.ts';
import { eventMatch } from './repo-event-match.ts';
import { type MissWindow, missWindow } from './repo-miss-authority.ts';
import { refsClear } from './repo-read-fences.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

export interface SearchRow {
  id: string;
  last_scan_at: number | null;
  last_scan_id: string | null;
}

type SearchKeys = { scanCode: string | null; barcodeHash: string; lookupHash: string };

function titleMatch(
  alias: 'matched' | 'lookup_match',
  column: 'display_title' | 'display_subtitle',
  q: string,
): { sql: string; params: SqlValue[] } {
  return prefixMatch(`${alias}.${column}`, q);
}

/** Share exact input matching between the indexed search and the miss's window check. */
function inputMatches(
  alias: 'matched' | 'lookup_match',
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
): { sql: string; params: SqlValue[] }[] {
  const matches: { sql: string; params: SqlValue[] }[] = [];
  if (email) {
    matches.push({
      sql: `${alias}.holder_email = ?`,
      params: [email],
    });
  } else if (!q.includes('@') && Array.from(q).length >= 3) {
    matches.push(titleMatch(alias, 'display_title', q), titleMatch(alias, 'display_subtitle', q));
  }
  if (keys) {
    matches.push({
      sql: `(${alias}.id = ? OR ${alias}.serial = ?
        OR ${alias}.external_id = ? OR ${alias}.scan_code = ?
        OR ${alias}.barcode_hash = ? OR ${alias}.lookup_hash = ?)`,
      params: [q, q, q, keys.scanCode, keys.barcodeHash, keys.lookupHash],
    });
  }
  return matches;
}

const RELEASE_SCOPE = {
  templateIdSql: 'p.template_id',
  orgIdSql: 'p.org_id',
  modeSql: 'p.mode',
  providerSql: "'apple'",
};
const ISSUED = issuedReleasePredicateSql(
  { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
  RELEASE_SCOPE,
);
type Fragment = { sql: string; params: SqlValue[] };

/** The tenant of a search: bound to the actor's own org and mode, or the grant row's (`{org}`, `{mode}`). */
type Tenant = 'actor' | 'grant';
const tenantTerms = (actor: ScanActor, tenant: Tenant) =>
  tenant === 'grant'
    ? { org: '{org}', mode: '{mode}', orgParams: [], modeParams: [] }
    : {
        org: '?',
        mode: '?',
        orgParams: [actor.orgId] as SqlValue[],
        modeParams: [actor.mode] as SqlValue[],
      };

/** An event's pass filter over a `passes` alias: '' when it takes every pass, null when it is invalid. */
function eventFilter(event: ScanEventRow, alias: string): Fragment | null {
  const match = eventMatch(event.matchInput, event.matchValues);
  if (!match) return null;
  if (match.input === null) return { sql: '', params: [] };
  return {
    sql: `EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.personalization) THEN ${alias}.personalization ELSE '{}' END) input
        JOIN json_each(?) allowed
          ON allowed.type='text' AND CAST(input.value AS TEXT)=allowed.value
        WHERE input.key=? AND input.type IN ('text','integer','real','true','false')
      )`,
    params: [JSON.stringify(match.values), match.input],
  };
}

const inTemplates = (alias: string, ids: readonly string[]): Fragment => ({
  sql: `${alias}.template_id IN (SELECT value FROM json_each(?) WHERE type='text')`,
  params: [JSON.stringify(ids)],
});

/** A mixed scope: a template entry, or an event's templates and filter. Null: nothing. */
function mixedScopeParts(
  actor: ScanActor,
  alias: string,
): { parts: string[]; params: SqlValue[] } | null {
  const any: Fragment[] = [];
  if (actor.entryTemplateIds?.length) any.push(inTemplates(alias, actor.entryTemplateIds));
  for (const { event, templateIds } of actor.events ?? []) {
    const filter = eventFilter(event, alias);
    const scope = inTemplates(alias, templateIds);
    if (filter)
      any.push({
        sql: filter.sql ? `(${scope.sql} AND ${filter.sql})` : scope.sql,
        params: [...scope.params, ...filter.params],
      });
  }
  if (any.length === 0) return null;
  return {
    parts: [`(${any.map((f) => f.sql).join(' OR ')})`],
    params: any.flatMap((f) => f.params),
  };
}

/** The actor's template and event scope over a `passes` alias: what a search may return. Null: nothing. */
function actorScopeParts(
  actor: ScanActor,
  alias: string,
): { parts: string[]; params: SqlValue[] } | null {
  if (actor.events) return mixedScopeParts(actor, alias);
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (actor.templateIds.length) {
    const scope = inTemplates(alias, actor.templateIds);
    parts.push(scope.sql);
    params.push(...scope.params);
  }
  if (actor.event) {
    const filter = eventFilter(actor.event, alias);
    if (!filter) return null;
    if (filter.sql) {
      parts.push(filter.sql);
      params.push(...filter.params);
    }
  }
  return { parts, params };
}

/** Shared exact eligibility for the indexed page and the miss's window check. */
function searchWhere(
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  credentialTombstoneRefs: readonly string[],
  tenant: Tenant,
): Fragment | null {
  if (
    actor.scanner?.deviceRole === 'scan' &&
    !actor.templateIds.length &&
    !actor.settings.acceptAllTemplates
  )
    return null;
  if (!Array.isArray(credentialTombstoneRefs) || credentialTombstoneRefs.length === 0) return null;
  const tombstones = refsClear(credentialTombstoneRefs, { org: 'p.org_id', mode: 'p.mode' });
  if (!tombstones) return null;
  const at = tenantTerms(actor, tenant);
  const where = [
    `p.org_id = ${at.org}`,
    `p.mode = ${at.mode}`,
    'p.deleted_at IS NULL',
    'p.removed_at IS NULL',
    "p.status = 'active'",
    'p.test_data_quarantined = 0',
    "typeof(p.credential_generation)='integer' AND p.credential_generation>=1",
    "typeof(p.lifecycle_generation)='integer' AND p.lifecycle_generation>=0",
    "typeof(p.image_generation)='integer' AND p.image_generation BETWEEN 0 AND 9007199254740991",
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id=p.id AND transfer.state='pending')`,
    `(${tombstones.sql})`,
    `(${walletSnapshotPredicateSql({ nowSql: '?' })})`,
    `(p.release_id IS NULL OR (${ISSUED}))`,
    `EXISTS (SELECT 1 FROM templates ot WHERE ot.id=p.template_id
      AND (ot.org_id IS NULL OR ot.org_id=p.org_id) AND ot.status!='deleted')`,
    `EXISTS (SELECT 1 FROM template_versions pinned
      WHERE pinned.template_id=p.template_id AND pinned.version=p.template_version)`,
  ];
  const params: SqlValue[] = [...at.orgParams, ...at.modeParams, ...tombstones.params, now];
  const scope = actorScopeParts(actor, 'p');
  if (!scope) return null;
  where.push(...scope.parts);
  params.push(...scope.params);
  const matches = inputMatches('matched', q, email, keys);
  if (!matches.length) return null;
  const indexed = matches.map((match) => {
    params.push(...at.orgParams, ...match.params);
    return `SELECT matched.id FROM passes matched WHERE matched.org_id = ${at.org} AND (${match.sql})`;
  });
  where.push(`p.id IN (${indexed.join(' UNION ')})`);

  return { sql: where.join(' AND '), params };
}

/** Scope is applied in SQL before the bounded page; search strings never leave the body. */
export function searchPassesStmt(
  db: D1Database,
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  offset: number,
  credentialTombstoneRefs: readonly string[],
): D1PreparedStatement | null {
  const where = searchWhere(actor, q, email, keys, now, credentialTombstoneRefs, 'actor');
  if (!where) return null;
  return exactStmt(
    db,
    `${RACE_SEARCH_PAGE} SELECT p.id,
    (SELECT max(at) FROM scans s WHERE s.pass_id = p.id AND s.org_id = p.org_id AND s.mode = p.mode AND s.state = 'done') AS last_scan_at,
    (SELECT s.id FROM scans s WHERE s.pass_id = p.id AND s.org_id = p.org_id AND s.mode = p.mode
      AND s.state = 'done' AND s.at IS NOT NULL ORDER BY s.at DESC, s.id DESC LIMIT 1) AS last_scan_id
    FROM passes p JOIN templates t ON t.id = p.template_id
      AND (t.org_id=p.org_id OR t.org_id IS NULL) AND t.status!='deleted'
    WHERE ${where.sql} ORDER BY p.display_title COLLATE NOCASE, p.id LIMIT 50 OFFSET ?`,
    [...where.params, offset],
  );
}

/**
 * True while a miss still stands: the same number of eligible passes match as the read saw, and no
 * matching pass has a transfer pending. `{org}` and `{mode}` are the grant's. Null when nothing can
 * be confirmed (the search itself was refused).
 */
export function searchWindowUnchanged(
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  credentialTombstoneRefs: readonly string[],
  observedCount: number,
): MissWindow | null {
  const where = searchWhere(actor, q, email, keys, now, credentialTombstoneRefs, 'grant');
  if (!where || !Number.isSafeInteger(observedCount) || observedCount < 0) return null;
  const matches = inputMatches('lookup_match', q, email, keys);
  // A pending transfer on a pass the read could not have returned is not a change to its answer.
  const scope = actorScopeParts(actor, 'lookup_match');
  if (!matches.length || !scope) return null;
  return missWindow(
    `(SELECT COUNT(*) FROM passes p JOIN templates t ON t.id=p.template_id
        AND (t.org_id=p.org_id OR t.org_id IS NULL) AND t.status!='deleted'
      WHERE (${where.sql})) = ?
      AND NOT EXISTS (SELECT 1 FROM passes lookup_match
        WHERE lookup_match.org_id={org} AND lookup_match.mode={mode}
          AND lookup_match.deleted_at IS NULL AND lookup_match.test_data_quarantined = 0
          AND (${matches.map((match) => `(${match.sql})`).join(' OR ')})
          ${scope.parts.map((part) => `AND ${part}`).join('\n          ')}
          AND EXISTS (SELECT 1 FROM pass_credential_transfers transfer
            WHERE transfer.pass_id=lookup_match.id AND transfer.state='pending'))`,
    [...where.params, observedCount, ...matches.flatMap((match) => match.params), ...scope.params],
  );
}

/** Decode a bounded search page after a direct query or a D1 authority batch. */
export const searchRowsOf = (result: D1Result | undefined): SearchRow[] =>
  (result?.results ?? []) as SearchRow[];

/** Later pages can be read directly after the initial actor-fenced batch. */
export async function searchPasses(
  db: D1Database,
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  offset: number,
  credentialTombstoneRefs: readonly string[],
): Promise<SearchRow[]> {
  const query = searchPassesStmt(db, actor, q, email, keys, now, offset, credentialTombstoneRefs);
  return query ? searchRowsOf(await query.all()) : [];
}
