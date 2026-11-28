import { z } from 'zod';
import { IdSchema } from './common.ts';

/** Shared with broadcasts and the passes list. */
export const ScanTargetSchema = z.union([
  z.object({ eventId: IdSchema, checkedIn: z.boolean() }),
  z.object({ noScanDays: z.number().int().min(1).max(730) }),
]);
export type ScanTarget = z.infer<typeof ScanTargetSchema>;
