import type { ScanReason } from '../contracts/scan.ts';
import {
  type ClientScanReason,
  SCAN_COPY,
  SCAN_REASON_COPY,
  SCAN_REASON_VARIANTS,
  scanLine,
} from './scan.ts';

/** What a reason headline can name. Unknown facts take the result screen's fallback words. */
export interface HeadlineFacts {
  actionKind?: string | null;
  action?: string | null;
  place?: string | null;
  flag?: string | null;
  input?: string | null;
}

/** The values a reason headline names; the result screen's line values start from these. */
export function headlineValues(f: HeadlineFacts): Record<string, string> {
  return {
    done:
      f.actionKind === 'check_in'
        ? SCAN_COPY.verdict.already.checkIn
        : SCAN_COPY.verdict.already.other,
    action: f.action ?? 'This action',
    place: f.place ?? '',
    flag: f.flag ?? 'Check required',
    input: f.input ?? 'This value',
  };
}

/** A reason's headline with every marker filled, for screens that show it alone (lookup, CSV). */
export function reasonHeadline(reason: string, f: HeadlineFacts = {}): string {
  const line = SCAN_REASON_COPY[reason as ScanReason | ClientScanReason] as
    | { headline: string }
    | undefined;
  if (!line) return reason;
  if (!f.place && reason === 'ended') return SCAN_REASON_VARIANTS.ended.noPlace;
  if (!f.place && reason === 'capacity_full') return SCAN_REASON_VARIANTS.capacity_full.noPlace;
  return scanLine(line.headline, headlineValues(f));
}
