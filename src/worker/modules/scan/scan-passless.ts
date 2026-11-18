import type { ScanReason } from '../../../shared/contracts/scan.ts';

/** Reasons a refusal can carry without selecting a pass: a code or tag the scanner could not use. */
export const PASSLESS_REASONS = [
  'not_found',
  'code_replaced',
  'ambiguous',
  'tag_lost',
  'tag_not_allowed',
  'tag_invalid',
] as const satisfies readonly ScanReason[];
export type PasslessReason = (typeof PASSLESS_REASONS)[number];

export const isPasslessReason = (reason: string | null): reason is PasslessReason =>
  (PASSLESS_REASONS as readonly (string | null)[]).includes(reason);

/** A passless refusal, identified by its `scans` row. Nothing else is stored or verified. */
export interface PasslessScan {
  readonly scanId: string;
  readonly orgId: string;
  readonly mode: 'live' | 'test';
  readonly at: number;
}
