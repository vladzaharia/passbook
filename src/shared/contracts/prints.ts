import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

/** `used` is reserved and never written: single use lives on the pass. Removing it would break clients. */
export const PRINT_STATUSES = ['active', 'voided', 'used'] as const;
export const PrintStatusSchema = z.enum(PRINT_STATUSES);

/** Why a print ended; `replaced` is a reprint, the rest follow the pass or an explicit void. */
export const PRINT_VOID_CAUSES = [
  'replaced',
  'manual',
  'holder',
  'pass_voided',
  'holder_change',
  'transfer',
  'new_code',
  'channel_off',
] as const;
export const PrintVoidCauseSchema = z.enum(PRINT_VOID_CAUSES);
export type PrintVoidCause = z.infer<typeof PrintVoidCauseSchema>;

export const PassPrintSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  generation: z.number().int().min(1),
  status: PrintStatusSchema,
  /** The pass version the print was made from; null for a print made before versions were recorded. */
  passVersion: z.number().int().min(1).nullable(),
  /**
   * The pass shows different values than this print was drawn from. Only an active print is ever stale.
   * Not stale means re-drawn from the current values, not proof that the paper on hand is new.
   */
  stale: z.boolean(),
  createdAt: TimestampSchema,
  voidedAt: TimestampSchema.nullable(),
  voidCause: z.string().nullable(),
});
export type PassPrint = z.infer<typeof PassPrintSchema>;

/** A minted print. `code` is shown to the printer once per request and never stored or logged. */
export const MintedPrintSchema = PassPrintSchema.extend({ code: z.string() });
export type MintedPrint = z.infer<typeof MintedPrintSchema>;

export const PassPrintsResponseSchema = z.object({ prints: z.array(PassPrintSchema) });

export const PrintParamSchema = z.object({ id: IdSchema, printId: IdSchema });

/** Passes one bulk Print takes: each is minted in the request, and one PDF carries them all. */
export const PRINT_BULK_MAX = 50;

export const BulkPrintSchema = z.object({
  ids: z.array(IdSchema).min(1).max(PRINT_BULK_MAX),
  orgId: IdSchema,
});

export const BulkPrintStartedSchema = z.object({
  jobId: z.string(),
  /** Tickets in the PDF. */
  count: z.number().int(),
  skipped: z.array(z.object({ id: IdSchema, code: z.string(), reason: z.string().optional() })),
});
export type BulkPrintStarted = z.infer<typeof BulkPrintStartedSchema>;

export const BulkPrintStatusSchema = z.object({
  state: z.enum(['pending', 'ready', 'failed']),
  count: z.number().int(),
  /** Passes left out because their print ended or they could not be read. */
  skipped: z.number().int(),
  engine: z.enum(['pdf-lib']).optional(),
  /** The PDF replaced characters it cannot draw. */
  lossy: z.boolean(),
});
export type BulkPrintStatus = z.infer<typeof BulkPrintStatusSchema>;

export const BulkPrintParamSchema = z.object({ jobId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
/** An org key leaves `orgId` out and reads its own org's jobs. */
export const BulkPrintQuerySchema = z.object({ orgId: IdSchema.optional() });
