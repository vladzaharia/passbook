import type { Channel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { type Policy, parsePolicy } from './repo.ts';

export type RunState = 'pending' | 'running' | 'done' | 'dropped' | 'failed';

/** Totals a run keeps as it goes: passes changed, effective flips, passes skipped as stale. */
export interface ApplyCounts {
  changed: number;
  flips: number;
  stale: number;
}

export interface ApplyRun {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  state: RunState;
  from: Policy;
  fromRevision: number;
  to: Policy | null;
  toRevision: number | null;
  replace: Channel[];
  requestedBy: string;
  dueAt: number;
  updatedAt: number;
  cursor: string | null;
  counts: ApplyCounts;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

interface RunRow {
  id: string;
  org_id: string;
  mode: Mode;
  template_id: string;
  state: RunState;
  from_channels: string;
  from_revision: number;
  to_channels: string | null;
  to_revision: number | null;
  replace_channels: string;
  requested_by: string;
  due_at: number;
  updated_at: number;
  cursor: string | null;
  counts: string;
  error_code: string | null;
  started_at: number | null;
  finished_at: number | null;
}

const COLUMNS = `id, org_id, mode, template_id, state, from_channels, from_revision, to_channels, to_revision,
  replace_channels, requested_by, due_at, updated_at, cursor, counts, error_code, started_at, finished_at`;

const map = (r: RunRow): ApplyRun => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  templateId: r.template_id,
  state: r.state,
  from: parsePolicy(r.from_channels),
  fromRevision: r.from_revision,
  to: r.to_channels === null ? null : parsePolicy(r.to_channels),
  toRevision: r.to_revision,
  replace: JSON.parse(r.replace_channels) as Channel[],
  requestedBy: r.requested_by,
  dueAt: r.due_at,
  updatedAt: r.updated_at,
  cursor: r.cursor,
  counts: { changed: 0, flips: 0, stale: 0, ...(JSON.parse(r.counts) as Partial<ApplyCounts>) },
  errorCode: r.error_code,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export async function getRun(db: D1Database, id: string): Promise<ApplyRun | null> {
  const r = await first<RunRow>(db, `SELECT ${COLUMNS} FROM channel_apply_runs WHERE id = ?`, [id]);
  return r ? map(r) : null;
}

/** The run waiting for its debounce, if any (at most one per template and mode). */
export async function pendingRun(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<ApplyRun | null> {
  const r = await first<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM channel_apply_runs
     WHERE org_id = ? AND mode = ? AND template_id = ? AND state = 'pending'`,
    [orgId, mode, templateId],
  );
  return r ? map(r) : null;
}

/** The latest runs of a template, newest first. */
export async function listRuns(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  limit = 10,
): Promise<ApplyRun[]> {
  const rows = await all<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM channel_apply_runs
     WHERE org_id = ? AND mode = ? AND template_id = ? ORDER BY id DESC LIMIT ?`,
    [orgId, mode, templateId, limit],
  );
  return rows.map(map);
}

/**
 * Pending runs past their debounce by the caller's grace: no instance picked them up. A run queued
 * behind a running run of its template is not stalled, it is waiting its turn.
 */
export async function stalledPending(
  db: D1Database,
  before: number,
  limit: number,
): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM channel_apply_runs p WHERE p.state = 'pending' AND p.due_at < ?
       AND NOT EXISTS (SELECT 1 FROM channel_apply_runs r WHERE r.org_id = p.org_id
         AND r.mode = p.mode AND r.template_id = p.template_id AND r.state = 'running')
     ORDER BY p.due_at LIMIT ?`,
    [before, limit],
  );
  return rows.map((r) => r.id);
}

/** The run of the template that is running now, if any. */
export async function runningRun(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<ApplyRun | null> {
  const r = await first<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM channel_apply_runs
     WHERE org_id = ? AND mode = ? AND template_id = ? AND state = 'running'`,
    [orgId, mode, templateId],
  );
  return r ? map(r) : null;
}

/** The newest run of the template and mode. */
export async function latestRun(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<ApplyRun | null> {
  return (await listRuns(db, orgId, mode, templateId, 1))[0] ?? null;
}
