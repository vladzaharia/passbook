import { likeEscape, type SqlValue, stmt } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import type { ScanActor } from './actor.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { eventMatch } from './repo-event-match.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

export interface SearchRow {
  id: string;
  last_scan_at: number | null;
  last_scan_id: string | null;
}

type SearchKeys = { scanCode: string | null; barcodeHash: string; lookupHash: string };

/** D1 rejects LIKE patterns over 50 bytes. */
const LIKE_PATTERN_BYTES = 50;
const utf8 = new TextEncoder();

/** A prefix too long for one pattern narrows by its head and compares the full prefix exactly. */
function prefixMatch(
  alias: 'matched' | 'lookup_match',
  column: 'display_title' | 'display_subtitle',
  q: string,
): { sql: string; params: SqlValue[] } {
  const label = column.replace('_', '-');
  const like = `${alias}.${column} LIKE ?/* scan-ephemeral-${label} */ ESCAPE '\\' COLLATE NOCASE`;
  const full = `${likeEscape(q)}%`;
  if (utf8.encode(full).length <= LIKE_PATTERN_BYTES) return { sql: like, params: [full] };
  let head = '';
  for (const char of q) {
    const next = head + likeEscape(char);
    if (utf8.encode(`${next}%`).length > LIKE_PATTERN_BYTES) break;
    head = next;
  }
  return {
    sql: `(${like} AND substr(${alias}.${column}, 1, ?) = ?/* scan-ephemeral-${label} */ COLLATE NOCASE)`,
    params: [`${head}%`, Array.from(q).length, q],
  };
}

/** Share exact input matching between the indexed search and the final miss fence. */
function inputMatches(
  alias: 'matched' | 'lookup_match',
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
): { sql: string; params: SqlValue[] }[] {
  const matches: { sql: string; params: SqlValue[] }[] = [];
  if (email) {
    matches.push({
      sql: `${alias}.holder_email = ?/* scan-ephemeral-holder-email */`,
      params: [email],
    });
  } else if (!q.includes('@') && Array.from(q).length >= 3) {
    matches.push(prefixMatch(alias, 'display_title', q), prefixMatch(alias, 'display_subtitle', q));
  }
  if (keys) {
    matches.push({
      sql: `(${alias}.id = ?/* scan-ephemeral-pass-id */ OR ${alias}.serial = ?/* scan-ephemeral-serial */
        OR ${alias}.external_id = ?/* scan-ephemeral-external-id */ OR ${alias}.scan_code = ?/* scan-ephemeral-scan-code */
        OR ${alias}.barcode_hash = ?/* scan-ephemeral-barcode-hash */ OR ${alias}.lookup_hash = ?/* scan-ephemeral-lookup-hash */)`,
      params: [q, q, q, keys.scanCode, keys.barcodeHash, keys.lookupHash],
    });
  }
  return matches;
}

/** Recheck the original input against one observed pass, without reusing a search result. */
export function searchObservedCandidatePredicate(
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  passId: string,
): OutputPredicate {
  const matches = inputMatches('lookup_match', q, email, keys);
  if (typeof passId !== 'string' || !passId || !matches.length) return { sql: '0', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM passes lookup_match WHERE lookup_match.org_id=? AND lookup_match.mode=?
      AND lookup_match.id=?/* scan-ephemeral-pass-id */
      AND (${matches.map((match) => `(${match.sql})`).join(' OR ')}))`,
    params: [actor.orgId, actor.mode, passId, ...matches.flatMap((match) => match.params)],
  };
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
/** Shared exact eligibility for the indexed page and its final window fence. */
function searchWhere(
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  credentialTombstoneRefs: readonly string[],
  credentialKeysetCommitment: string,
): OutputPredicate | null {
  if (
    actor.scanner?.deviceRole === 'scan' &&
    !actor.templateIds.length &&
    !actor.settings.acceptAllTemplates
  )
    return null;
  if (!Array.isArray(credentialTombstoneRefs) || credentialTombstoneRefs.length === 0) return null;
  const tombstones = noCredentialTombstonesSql(
    credentialTombstoneRefs,
    {
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
    },
    credentialKeysetCommitment,
  );
  if (tombstones.sql === '0') return null;
  const where = [
    'p.org_id = ?',
    'p.mode = ?',
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
  const params: SqlValue[] = [actor.orgId, actor.mode, ...tombstones.params, now];
  if (actor.templateIds.length) {
    where.push(
      "p.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */) WHERE type='text')",
    );
    params.push(JSON.stringify(actor.templateIds));
  }
  if (actor.event) {
    const match = eventMatch(actor.event.matchInput, actor.event.matchValues);
    if (!match) return null;
    if (match.input !== null) {
      where.push(`EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(p.personalization) THEN p.personalization ELSE '{}' END) input
        JOIN json_each(?/* scan-ephemeral-event-match-values */) allowed
          ON allowed.type='text' AND CAST(input.value AS TEXT)=allowed.value
        WHERE input.key=?/* scan-ephemeral-event-match-input */ AND input.type IN ('text','integer','real','true','false')
      )`);
      params.push(JSON.stringify(match.values), match.input);
    }
  }
  const matches = inputMatches('matched', q, email, keys);
  if (!matches.length) return null;
  const indexed = matches.map((match) => {
    params.push(actor.orgId, ...match.params);
    return `SELECT matched.id FROM passes matched WHERE matched.org_id = ? AND (${match.sql})`;
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
  credentialKeysetCommitment: string,
): D1PreparedStatement | null {
  const where = searchWhere(
    actor,
    q,
    email,
    keys,
    now,
    credentialTombstoneRefs,
    credentialKeysetCommitment,
  );
  if (!where) return null;
  return stmt(
    db,
    `SELECT p.id,
    (SELECT max(at) FROM scans s WHERE s.pass_id = p.id AND s.org_id = p.org_id AND s.mode = p.mode AND s.state = 'done') AS last_scan_at,
    (SELECT s.id FROM scans s WHERE s.pass_id = p.id AND s.org_id = p.org_id AND s.mode = p.mode
      AND s.state = 'done' AND s.at IS NOT NULL ORDER BY s.at DESC, s.id DESC LIMIT 1) AS last_scan_id
    FROM passes p JOIN templates t ON t.id = p.template_id
      AND (t.org_id=p.org_id OR t.org_id IS NULL) AND t.status!='deleted'
    WHERE ${where.sql} ORDER BY p.display_title COLLATE NOCASE, p.id LIMIT 50 OFFSET ?`,
    [...where.params, offset],
  );
}

/** A miss is stale if a new eligible match appears or any matching transfer is pending. */
export function searchInputWindowChangedPredicate(
  actor: ScanActor,
  q: string,
  email: string | null,
  keys: SearchKeys | undefined,
  now: number,
  credentialTombstoneRefs: readonly string[],
  credentialKeysetCommitment: string,
  observedCount: number,
): OutputPredicate {
  const where = searchWhere(
    actor,
    q,
    email,
    keys,
    now,
    credentialTombstoneRefs,
    credentialKeysetCommitment,
  );
  if (!where || !Number.isSafeInteger(observedCount) || observedCount < 0)
    return { sql: '1', params: [] };
  const matches = inputMatches('lookup_match', q, email, keys);
  if (!matches.length) return { sql: '1', params: [] };
  return {
    sql: `(SELECT COUNT(*) FROM passes p JOIN templates t ON t.id=p.template_id
        AND (t.org_id=p.org_id OR t.org_id IS NULL) AND t.status!='deleted'
      WHERE (${where.sql})) != ?
      OR EXISTS (SELECT 1 FROM passes lookup_match
        WHERE lookup_match.org_id=? AND lookup_match.mode=?
          AND (${matches.map((match) => `(${match.sql})`).join(' OR ')})
          AND EXISTS (SELECT 1 FROM pass_credential_transfers transfer
            WHERE transfer.pass_id=lookup_match.id AND transfer.state='pending'))`,
    params: [
      ...where.params,
      observedCount,
      actor.orgId,
      actor.mode,
      ...matches.flatMap((match) => match.params),
    ],
  };
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
  credentialKeysetCommitment: string,
): Promise<SearchRow[]> {
  const query = searchPassesStmt(
    db,
    actor,
    q,
    email,
    keys,
    now,
    offset,
    credentialTombstoneRefs,
    credentialKeysetCommitment,
  );
  return query ? searchRowsOf(await query.all()) : [];
}
