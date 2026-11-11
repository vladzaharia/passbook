import { StaleScanAuthority } from './act-override.ts';
import type { ObservedScanEffect } from './repo-scan-effect.ts';

export interface HeldHolder {
  scan_id: string | null;
  gate_scan_id: string;
  at: number;
  scan_state: string | null;
  action_id: string | null;
  scanner_id: string | null;
  staff_id: string | null;
  last_at: number;
  scanner_name: string | null;
  staff_name: string | null;
  override_of: string | null;
}

export function heldGateHolder(
  holderResult: D1Result,
  observed: ObservedScanEffect,
): HeldHolder | undefined {
  const holder = holderResult.results?.[0] as HeldHolder | undefined;
  if (
    (observed.gateBefore &&
      (!holder ||
        holder.gate_scan_id !== observed.gateBefore.lastScanId ||
        holder.scan_state !== observed.gateBefore.holderState ||
        holder.last_at !== observed.gateBefore.lastAt)) ||
    (!observed.gateBefore && holder)
  )
    throw new StaleScanAuthority();
  return holder;
}
