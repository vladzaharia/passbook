/** Outcomes the client makes itself: system verdicts, local refusals, offline saves. */
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import type { Counts, ScanOutcome } from './types.ts';

export const EMPTY_COUNTS: Counts = { today: 0, event: null, asOf: 0, configRev: 0 };

export function localOutcome(
  kind: 'system' | 'refused' | 'queued',
  reason: NonNullable<ScanOutcome['reason']>,
  counts: Counts | null,
  extra: Partial<ScanOutcome> = {},
): ScanOutcome {
  return {
    scanId: null,
    kind,
    reason,
    replay: false,
    action: null,
    card: null,
    previous: null,
    template: null,
    at: null,
    cooldownRemainingMs: null,
    value: null,
    flags: [],
    overridable: false,
    approvals: false,
    group: null,
    counts: counts ?? EMPTY_COUNTS,
    milestone: null,
    undoUntil: null,
    access: null,
    display: null,
    local: true,
    ...extra,
  };
}

/** The headline of a reason, for the chip on a repeated refused code. Unknown reasons get a generic one. */
export function headlineOf(reason: ScanOutcome['reason']): string {
  const line = reason ? (SCAN_REASON_COPY as Record<string, { headline: string }>)[reason] : null;
  return line ? line.headline.replace(/\{\w+\}/g, '').trim() || 'Refused' : 'Refused';
}
