import { z } from 'zod';
import { IdSchema } from './common.ts';

/**
 * One pass of the bundle, scanned pass first: initials only, empty when this role may not read the
 * pass's name (the same rule as the card's title). `refusedReason` is a scan reason, when known.
 */
export const ScanBundleMemberSchema = z.object({
  initials: z.string().max(4),
  checkedIn: z.boolean(),
  refusedReason: z.string().nullable().optional(),
});

/** The bundle behind a scanned pass: the "Check in all" chip. */
export const ScanBundleSchema = z.object({
  id: IdSchema,
  name: z.string(),
  size: z.number().int(),
  checkedIn: z.number().int().nullable(),
  members: z.array(ScanBundleMemberSchema).max(10).optional(),
});

/** One member's verdict in a group check-in; `reason` is a scan reason. */
export const ScanGroupMemberSchema = z.object({
  name: z.string(),
  state: z.enum(['done', 'already', 'refused']),
  reason: z.string().nullable(),
});
