import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

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
