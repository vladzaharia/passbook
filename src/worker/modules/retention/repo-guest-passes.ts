import { all, first } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../scan/effective-release.ts';
import type { Scope } from './repo-sweep.ts';

export interface GuestCandidate {
  id: string;
  org_id: string;
  row_version: number;
  created_at: number;
  personalization: string;
  /** `scan.access` and `inputs` of the pass's own (pinned) template version. */
  access: string;
  inputs: string | null;
  /** The same for the version of the release the door reads now. */
  active_access: string;
  active_inputs: string | null;
}

/** An org-wide hold, or a hold on this pass. */
const heldSql = (org: string, pass: string) =>
  `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${org}
     AND (h.pass_id IS NULL OR h.pass_id = ${pass}))`;

/** The pass's plan under the manifest of version `v`: its own input, else the input's default. */
const planOf = (v: string) => {
  const key = `json_extract(${v}.manifest, '$.scan.access.input.plan')`;
  return `COALESCE(
    (SELECT pe.value FROM json_each(p.personalization) pe WHERE pe.key = ${key} AND pe.type != 'null'),
    (SELECT json_extract(pr.value, '$.default') FROM json_each(${v}.manifest, '$.inputs.properties') pr
      WHERE pr.key = ${key}))`;
};
const guestIds = (v: string) =>
  `SELECT json_extract(pl.value, '$.id') FROM json_each(${v}.manifest, '$.scan.access.plans') pl
     WHERE json_extract(pl.value, '$.kind') = 'guest'`;
const isGuest = (v: string) => `${planOf(v)} IN (${guestIds(v)})`;

/**
 * Live, undeleted passes created before `before`, found template-first: template versions that have a guest plan
 * (CROSS JOIN keeps them as the outer loop, so passes come from `passes_template`, never a scan of every pass).
 * The plan input must name a guest plan under the pinned version and under the release the door reads now
 * (`effectiveReleaseIdSql`, as the scan lookup); no hold and no pending credential transfer. Id order after the
 * cursor. The end is decided by the caller: it needs the time zone the door uses.
 */
export const GUEST_CANDIDATES_SQL = (
  scope: Scope['kind'],
) => `SELECT p.id, p.org_id, p.row_version, p.created_at,
    p.personalization, json_extract(v.manifest, '$.scan.access') AS access, json_extract(v.manifest, '$.inputs') AS inputs,
    json_extract(av.manifest, '$.scan.access') AS active_access, json_extract(av.manifest, '$.inputs') AS active_inputs
  FROM template_versions v
  CROSS JOIN passes p ON p.template_id = v.template_id AND p.template_version = v.version
  LEFT JOIN template_releases ar ON ar.id = ${effectiveReleaseIdSql('p')}
  JOIN template_versions av ON av.template_id = p.template_id AND av.version = COALESCE(ar.version, p.template_version)
  WHERE EXISTS (SELECT 1 FROM json_each(v.manifest, '$.scan.access.plans') g WHERE json_extract(g.value, '$.kind') = 'guest')
    AND p.mode = 'live' AND p.deleted_at IS NULL AND p.created_at < ? AND p.id > ?
    AND ${scope === 'org' ? 'p.org_id = ?' : 'p.org_id NOT IN (SELECT value FROM json_each(?))'}
    AND ${isGuest('v')} AND ${isGuest('av')}
    AND NOT ${heldSql('p.org_id', 'p.id')}
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
  ORDER BY p.id LIMIT ?`;

export function guestCandidates(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const param = scope.kind === 'org' ? scope.orgId : JSON.stringify(scope.exclude);
  return all<GuestCandidate>(db, GUEST_CANDIDATES_SQL(scope.kind), [before, after, param, limit]);
}

/** Whether the receipt row landed (its in-batch insert is refused when another writer took the chain slot). */
export async function receiptExists(db: D1Database, id: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS x FROM retention_receipts WHERE id = ?', [id])) !== null;
}

/** A receipt gate: the receipt lands only while the pass carries this delete's timestamp. */
export const deletedGate = (passId: string, at: number) => ({
  sql: '(SELECT count(*) FROM passes WHERE id = ? AND deleted_at = ?) = ?',
  params: [passId, at, 1],
});
