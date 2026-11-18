import { z } from 'zod';
import { BroadcastTargetSchema } from '../../../shared/contracts/broadcasts.ts';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { RuleWindowSchema } from '../message-rules/windows.ts';

/**
 * What a run reads. The public schema strips `window` and `sentBy`, so only the server can set them:
 * the due window of an automatic message, and the run whose updated passes a follow-up clears.
 */
export const StoredBroadcastTargetSchema = BroadcastTargetSchema.extend({
  window: RuleWindowSchema.optional(),
  sentBy: IdSchema.optional(),
  /** A test send of an automatic message: this pass only. */
  passIds: z.array(IdSchema).max(1).optional(),
});
