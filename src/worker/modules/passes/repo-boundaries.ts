import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, first, stmt } from '../../platform/db.ts';

/** A claim holds a row from other ticks this long; a lost job is claimed again after it. */
export const BOUNDARY_LEASE_MS = 5 * 60_000;

/** A row of an org that is not active waits this long before it is looked at again. */
export const BOUNDARY_PARKED_MS = 60 * 60_000;

/**
 * Claims due rows in one batch: each takes the lease as its due time, so the job that works it compares
 * against that value. Each org gets at most `perOrg` a tick and its rows interleave with the other orgs'
 * (rank within the org first); live before test. Due rows of an org that is not active (or a developer
 * org, which the trigger leaves out) are parked for an hour, last, so no claim scans them each minute.
 */
export async function claimDueBoundaries(
  db: D1Database,
  p: { now: number; lease: number; limit: number; perOrg: number },
): Promise<string[]> {
  const [claimed] = await batch(db, [
    stmt(
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
    ),
    stmt(
      db,
      `UPDATE pass_boundaries SET due_at = ?
       WHERE pass_id IN (
         SELECT b.pass_id FROM pass_boundaries b
         JOIN passes p ON p.id = b.pass_id
         JOIN orgs o ON o.id = p.org_id
         WHERE b.due_at <= ? AND (o.status != 'active' OR o.kind = 'developer')
         ORDER BY b.due_at LIMIT ?)
       RETURNING pass_id`,
      [p.now + BOUNDARY_PARKED_MS, p.now, p.limit],
    ),
  ]);
  return ((claimed?.results ?? []) as { pass_id: string }[]).map((r) => r.pass_id);
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

/**
 * The boundary row of the pass's current artifact: its render when one was made, and when the last render
 * was stamped (it outlives a new artifact, for the Last-Modified collision).
 */
export interface CurrentRender {
  renderedAt: number;
  stampedAt: number;
  render: string | null;
}

export async function currentRenders(
  db: D1Database,
  passes: readonly { id: string; objectKey: string }[],
): Promise<Map<string, CurrentRender>> {
  const out = new Map<string, CurrentRender>();
  if (passes.length === 0) return out;
  const rows = await all<{
    pass_id: string;
    object_key: string;
    rendered_at: number;
    stamped_at: number;
    render: string | null;
  }>(
    db,
    `SELECT pass_id, object_key, rendered_at, stamped_at, render FROM pass_boundaries
     WHERE pass_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(passes.map((p) => p.id))],
  );
  const keys = new Map(passes.map((p) => [p.id, p.objectKey]));
  for (const row of rows)
    if (keys.get(row.pass_id) === row.object_key)
      out.set(row.pass_id, {
        renderedAt: row.rendered_at,
        stampedAt: row.stamped_at,
        render: row.rendered_at > 0 ? row.render : null,
      });
  return out;
}

/** What a wallet's boundaries are read from: the pass's template and its latest artifact pass.json. */
export async function boundarySource(
  db: D1Database,
  passId: string,
): Promise<{
  orgId: string;
  templateId: string;
  templateVersion: string;
  personalization: string;
  passJson: string | null;
} | null> {
  const row = await first<{
    org_id: string;
    template_id: string;
    template_version: string;
    personalization: string;
    pass_json: string | null;
  }>(
    db,
    `SELECT p.org_id, p.template_id, p.template_version, p.personalization,
       (SELECT v.pass_json FROM pass_versions v WHERE v.pass_id = p.id
         ORDER BY v.version DESC LIMIT 1) AS pass_json
     FROM passes p WHERE p.id = ?`,
    [passId],
  );
  return row
    ? {
        orgId: row.org_id,
        templateId: row.template_id,
        templateVersion: row.template_version,
        personalization: row.personalization,
        passJson: row.pass_json,
      }
    : null;
}
