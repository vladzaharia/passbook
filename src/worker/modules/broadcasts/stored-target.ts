import { z } from 'zod';
import { BroadcastTargetSchema } from '../../../shared/contracts/broadcasts.ts';
import { CHANGE_RUN_MAX_PASS_IDS } from '../../../shared/contracts/broadcasts-change.ts';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { RuleWindowSchema } from '../message-rules/windows.ts';

/**
 * What a run reads. The public schema strips what only the server sets: the due window of an
 * automatic message, the run whose updated passes a follow-up clears, and a change run's own
 * selection and text.
 */
export const StoredBroadcastTargetSchema = BroadcastTargetSchema.extend({
  window: RuleWindowSchema.optional(),
  sentBy: IdSchema.optional(),
  /** A test send of an automatic message (one pass), or a change run's chosen passes. */
  passIds: z.array(IdSchema).max(CHANGE_RUN_MAX_PASS_IDS).optional(),
  /** A change run on the passes one import created or updated. */
  importId: IdSchema.optional(),
  /** The count the admin saw: a run that starts far from it ends failed, applying nothing. */
  expectCount: z.number().int().nonnegative().optional(),
  /** An undo: the change run whose items it restores. */
  revertOf: IdSchema.optional(),
  /** A change run's lock-screen text, with `{Label}` tokens. */
  message: z.string().max(200).optional(),
});
export type StoredBroadcastTarget = z.infer<typeof StoredBroadcastTargetSchema>;
