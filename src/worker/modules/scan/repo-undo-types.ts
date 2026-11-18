import type { AfterRead } from '../../platform/authority-after.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import type { ScanRow } from './repo-scans.ts';
import type { ScanEventRow } from './repo-scope.ts';

export interface UndoGate {
  /** An Access card's visit gate is `access` (`visit`, `visit_at`: its visit counting). */
  action_id: string;
  visit: number | null;
  visit_at: number | null;
  prev_visit_at: number | null;
  scope: string;
  template_id: string;
  kind: string;
  state: string;
  count: number;
  first_at: number;
  last_at: number;
  prev_state: string | null;
  prev_last_at: number | null;
  prev_scan_id: string | null;
}

export interface UndoPresence {
  state: string;
  tracking: number;
  entered_at: number | null;
  first_at: number;
  last_entry_at: number;
  prev_state: string | null;
  prev_tracking: number | null;
  prev_entered_at: number | null;
  prev_first_at: number | null;
  prev_last_entry_at: number | null;
  prev_scan_id: string | null;
  /** Commit order (0074); the restore puts the previous one back. */
  prev_seq?: number | null;
}

export interface UndoCommit {
  ctx: ServiceContext;
  actor: ScanActor;
  target: ScanRow & { passId: string; actionId: string };
  gate: UndoGate;
  presence: UndoPresence | null;
  event: ScanEventRow | null;
  /** The manager whose PIN was verified: still enabled, still a manager, same `auth_epoch`. */
  approver: { id: string; authEpoch: number } | null;
  id: string;
  key: string;
  /** The answer's reads: they commit with the grant, so the undo needs no trip of its own for them. */
  reads?: readonly AfterRead[];
}
