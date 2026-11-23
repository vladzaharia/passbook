import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

/** A claim holds a row from other ticks this long; a lost job is claimed again after it. */
export const BOUNDARY_LEASE_MS = 5 * 60_000;

/**
 * Claims due rows in one statement: each takes the lease as its due time, so the job that works it
 * compares against that value. Each org gets at most `perOrg` a tick and its rows interleave with the
 * other orgs' (rank within the org first); live before test. Rows of an org that is not active, or
 * of a developer org (its passes are never signed), wait with their due time.
 */
export async function claimDueBoundaries(
  db: D1Database,
  p: { now: number; lease: number; limit: number; perOrg: number },
): Promise<string[]> {
  const rows = await all<{ pass_id: string }>(
    db,
    `UPDATE pass_boundaries SET due_at = ?
     WHERE pass_id IN (
       SELECT pass_id FROM (
         SELECT b.pass_id, b.due_at, p.mode, ROW_NUMBER() OVER (
           PARTITION BY p.org_id ORDER BY p.mode = 'test', b.due_at, b.pass_id) AS n
         FROM pass_boundaries b
         JOIN passes p ON p.id = b.pass_id
         JOIN orgs o ON o.id = p.org_id
         WHERE b.due_at <= ? AND o.status = 'active' AND o.kind != 'developer'
       ) WHERE n <= ?
       ORDER BY mode = 'test', n, due_at, pass_id LIMIT ?)
     RETURNING pass_id`,
    [p.lease, p.now, p.perOrg, p.limit],
  );
  return rows.map((r) => r.pass_id);
}

/** A claimed row with what the job needs of its pass and artifact, read in one query. */
export interface BoundaryWork {
  passId: string;
  objectKey: string;
  dueAt: number | null;
  renderedAt: number;
  render: string | null;
  stampedAt: number;
  attempts: number;
  /** The artifact's stored pass.json; null once purged. */
  passJson: string | null;
  pass: {
    orgId: string;
    mode: Mode;
    objectKey: string;
    status: string;
    removedAt: number | null;
    deletedAt: number | null;
    quarantined: boolean;
    templateId: string;
    templateVersion: string;
    releaseId: string | null;
    identityId: string;
    credentialGeneration: number;
    lifecycleGeneration: number;
    personalization: string;
  };
}

type Cell = string | number | null;
const num = (v: Cell) => (v === null ? null : Number(v));
const text = (v: Cell) => (v === null ? null : String(v));

export async function readBoundaryWork(
  db: D1Database,
  passId: string,
): Promise<BoundaryWork | null> {
  const row = await first<Record<string, Cell>>(
    db,
    `SELECT b.object_key, b.due_at, b.rendered_at, b.render, b.stamped_at, b.attempts, v.pass_json,
       p.org_id, p.mode, p.object_key AS pass_object_key, p.status, p.removed_at, p.deleted_at,
       p.test_data_quarantined, p.template_id, p.template_version, p.release_id, p.identity_id,
       p.credential_generation, p.lifecycle_generation, p.personalization
     FROM pass_boundaries b JOIN passes p ON p.id = b.pass_id
     LEFT JOIN pass_versions v ON v.pass_id = b.pass_id AND v.version = b.version
       AND v.object_key = b.object_key
     WHERE b.pass_id = ?`,
    [passId],
  );
  if (!row) return null;
  return {
    passId,
    objectKey: String(row.object_key),
    dueAt: num(row.due_at ?? null),
    renderedAt: Number(row.rendered_at),
    render: text(row.render ?? null),
    stampedAt: Number(row.stamped_at),
    attempts: Number(row.attempts),
    passJson: text(row.pass_json ?? null),
    pass: {
      orgId: String(row.org_id),
      mode: row.mode as Mode,
      objectKey: String(row.pass_object_key),
      status: String(row.status),
      removedAt: num(row.removed_at ?? null),
      deletedAt: num(row.deleted_at ?? null),
      quarantined: Number(row.test_data_quarantined) !== 0,
      templateId: String(row.template_id),
      templateVersion: String(row.template_version),
      releaseId: text(row.release_id ?? null),
      identityId: String(row.identity_id),
      credentialGeneration: Number(row.credential_generation),
      lifecycleGeneration: Number(row.lifecycle_generation),
      personalization: String(row.personalization),
    },
  };
}

/** The claim a job holds: a new artifact (the trigger) or a later claim moves `due_at` off it. */
export interface BoundaryClaim {
  passId: string;
  objectKey: string;
  lease: number;
}

/** Moves a claimed row to its next due time (null: nothing left to work out). False when stale. */
export async function moveBoundary(
  db: D1Database,
  claim: BoundaryClaim,
  dueAt: number | null,
  attempts = 0,
): Promise<boolean> {
  const rows = await all(
    db,
    `UPDATE pass_boundaries SET due_at = ?, attempts = ?
     WHERE pass_id = ? AND object_key = ? AND due_at = ? RETURNING pass_id`,
    [dueAt, attempts, claim.passId, claim.objectKey, claim.lease],
  );
  return rows.length === 1;
}

/** Deletes a claimed row: the pass can no longer change with the clock. False when stale. */
export async function dropBoundary(db: D1Database, claim: BoundaryClaim): Promise<boolean> {
  const rows = await all(
    db,
    `DELETE FROM pass_boundaries WHERE pass_id = ? AND object_key = ? AND due_at = ?
     RETURNING pass_id`,
    [claim.passId, claim.objectKey, claim.lease],
  );
  return rows.length === 1;
}

/** The render devices get for the pass's current artifact, if one was made. */
export async function currentRender(
  db: D1Database,
  pass: { id: string; objectKey: string },
): Promise<{ renderedAt: number; stampedAt: number; render: string } | null> {
  const row = await first<{ rendered_at: number; stamped_at: number; render: string }>(
    db,
    `SELECT rendered_at, stamped_at, render FROM pass_boundaries
     WHERE pass_id = ? AND object_key = ? AND rendered_at > 0 AND render IS NOT NULL`,
    [pass.id, pass.objectKey],
  );
  return row
    ? { renderedAt: row.rendered_at, stampedAt: row.stamped_at, render: row.render }
    : null;
}
