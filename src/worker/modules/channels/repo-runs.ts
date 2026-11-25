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
  /** New codes issued, and passes whose barcode is not the scan code (skipped). */
  rotated: number;
  unsupported: number;
}

export const REPLACE_PRINCIPAL_REVOKED = 'REPLACE_PRINCIPAL_REVOKED';

/** Whether the run still replaces codes: it asked to, and its requester kept the right at the start. */
export const rotating = (run: Pick<ApplyRun, 'replace' | 'errorCode'>): boolean =>
  run.replace.length > 0 && run.errorCode !== REPLACE_PRINCIPAL_REVOKED;

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
  /** An entitlement run: the channels the plan blocked before the change. Null for a template save. */
  fromBlocked: Channel[] | null;
  /** The channels the plan blocked after it; null on a run made before 0153 (the plan as it is then). */
  toBlocked: Channel[] | null;
  /** The entitlement revisions the run covers, `from_rev` to `to_rev`; null on a template-save run. */
  fromRev: number | null;
  toRev: number | null;
  /** A full reconcile: every pass is brought to `toBlocked` (stop what it blocks, resume what it allows); never dropped as a no-op. */
  reconcileAll: boolean;
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
  from_blocked: string | null;
  to_blocked: string | null;
  from_rev: number | null;
  to_rev: number | null;
  reconcile_all: number;
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
  replace_channels, from_blocked, to_blocked, from_rev, to_rev, reconcile_all, requested_by, due_at, updated_at, cursor, counts, error_code, started_at, finished_at`;

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
  fromBlocked: r.from_blocked === null ? null : (JSON.parse(r.from_blocked) as Channel[]),
  toBlocked: r.to_blocked === null ? null : (JSON.parse(r.to_blocked) as Channel[]),
  fromRev: r.from_rev,
  toRev: r.to_rev,
  reconcileAll: r.reconcile_all === 1,
  requestedBy: r.requested_by,
  dueAt: r.due_at,
  updatedAt: r.updated_at,
  cursor: r.cursor,
  counts: {
    changed: 0,
    flips: 0,
    stale: 0,
    rotated: 0,
    unsupported: 0,
    ...(JSON.parse(r.counts) as Partial<ApplyCounts>),
  },
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

/** The run before this one for the template and mode, ignoring dropped runs (they applied nothing). */
export async function priorRun(db: D1Database, run: ApplyRun): Promise<ApplyRun | null> {
  const r = await first<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM channel_apply_runs
     WHERE org_id = ? AND mode = ? AND template_id = ? AND id < ? AND state != 'dropped'
     ORDER BY id DESC LIMIT 1`,
    [run.orgId, run.mode, run.templateId, run.id],
  );
  return r ? map(r) : null;
}

/** Running runs that wrote nothing since `before`: their instance may be gone. */
export async function idleRunning(
  db: D1Database,
  before: number,
  limit: number,
): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    "SELECT id FROM channel_apply_runs WHERE state = 'running' AND updated_at < ? ORDER BY updated_at LIMIT ?",
    [before, limit],
  );
  return rows.map((r) => r.id);
}
