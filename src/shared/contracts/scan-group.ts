import { z } from 'zod';
import { IdSchema } from './common.ts';

/** The bundle behind a scanned pass: the "Check in all" chip. */
export const ScanBundleSchema = z.object({
  id: IdSchema,
  name: z.string(),
  size: z.number().int(),
  checkedIn: z.number().int().nullable(),
});

/** One member's verdict in a group check-in; `reason` is a scan reason. */
export const ScanGroupMemberSchema = z.object({
  name: z.string(),
  state: z.enum(['done', 'already', 'refused']),
  reason: z.string().nullable(),
});
