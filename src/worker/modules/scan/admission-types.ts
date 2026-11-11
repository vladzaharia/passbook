import type { CheckInPolicy, CheckInState } from '../../../shared/contracts/check-in.ts';
import type { ScanPresenceSnapshot } from './repo-scan-effect.ts';
import type { ScanEventRow } from './repo-scope.ts';

export interface AdmissionPlan {
  state: CheckInState;
  rules: CheckInPolicy[];
  scope: string;
  event: ScanEventRow | null;
  tracked: boolean;
  previousScanId: string | null;
  /** Exact row used to make the admission decision, including the absence of a row. */
  presence: ScanPresenceSnapshot | null;
  limitSince: number | null;
  /** Explicit policy limits apply across every check-in action. */
  limited: boolean;
}

export interface AdmissionHistory {
  first_at: number | null;
  last_at: number | null;
  today_at: number | null;
}

export interface PresenceRow {
  pass_id: string;
  org_id: string;
  scope: string;
  state: 'in' | 'out';
  tracking: number;
  entered_at: number | null;
  first_at: number;
  last_entry_at: number;
  last_scan_id: string;
  prev_state: string | null;
  prev_tracking: number | null;
  prev_entered_at: number | null;
  prev_first_at: number | null;
  prev_last_entry_at: number | null;
  prev_scan_id: string | null;
}
