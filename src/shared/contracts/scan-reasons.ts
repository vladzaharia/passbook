import { z } from 'zod';

/** Wire reasons. The client-only ones (network, timeout, ...) live in `src/web/scan/machine/types.ts`. */
export const SCAN_REFUSED_REASONS = [
  'not_found',
  'code_replaced',
  'ambiguous',
  'test_pass',
  'live_pass',
  'not_accepted',
  'wrong_event',
  'removed',
  'voided',
  'expired',
  'no_balance',
  'card_full',
  'managed_elsewhere',
  'limit_reached',
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'guest_visits_used',
  'suspended',
  'tag_lost',
  'tag_not_allowed',
  'tag_invalid',
  'tag_expired',
  'channel_off',
  'print_replaced',
  'print_voided',
] as const;
export const SCAN_HEADS_UP_REASONS = [
  'already_done',
  'cooldown',
  'not_yet_valid',
  'ended',
  'capacity_full',
  'check_required',
  'needs_approval',
  'stale',
  'in_progress',
  'still_inside',
  'not_inside',
] as const;
export const ScanReasonSchema = z.enum([
  ...SCAN_REFUSED_REASONS,
  ...SCAN_HEADS_UP_REASONS,
  'choose',
]);
export type ScanReason = z.infer<typeof ScanReasonSchema>;
