import type { AfterRead } from '../../platform/authority-after.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import type { OccupancyRow } from './occupancy/repo.ts';
import type { OccZone } from './occupancy/rules.ts';
import type { ScanRow } from './repo-scans.ts';
import type { ScanEventRow } from './repo-scope.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';

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
  /** The target's signed action reference, from its ledger row. */
  action_id_ref?: string | null;
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
  /** A scan at a tracked zone: its group's rows go back together (SA §20.8). */
  occupancy?: OccupancyUndo | null;
  event: ScanEventRow | null;
  /** The manager whose PIN was verified: still enabled, still a manager, same `auth_epoch`. */
  approver: { id: string; authEpoch: number } | null;
  id: string;
  key: string;
  /** The undo's signed proof, made at the clock its rows use (`prepareUndoRetention`). */
  retention?: PreparedScanRetentionProof | null;
  /** The answer's reads: they commit with the grant, so the undo needs no trip of its own for them. */
  reads?: readonly AfterRead[];
}

/** What an occupancy scan's undo read: its group, the rows the group still holds, and the zones. */
export interface OccupancyUndo {
  group: string[];
  /** The group's latest scan time: a zone saved after it supersedes the undo. */
  scannedAt: number;
  rows: OccupancyRow[];
  zones: OccZone[];
}
