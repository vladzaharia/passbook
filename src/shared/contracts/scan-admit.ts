import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import { TimeZoneSchema } from './scan-base.ts';

/** Why a pass was admitted. The client words it in `timeZone`. Null when the type has no rule to show. */
export const ScanAdmitRuleSchema = z.discriminatedUnion('kind', [
  /** A day pass or timed grant: when it ends. */
  z.object({ kind: z.literal('until'), at: TimestampSchema }),
  /** A visit pack or guest card: this is visit `n` of `of`. */
  z.object({ kind: z.literal('visit'), n: z.number().int(), of: z.number().int().nullable() }),
  /** A visit pack scan that did not count: `n` visits remain. */
  z.object({ kind: z.literal('left'), n: z.number().int() }),
  z.object({ kind: z.literal('event'), name: z.string() }),
  z.object({ kind: z.literal('once') }),
  z.object({ kind: z.literal('daily') }),
]);

/** What admitted or refused a scan: the pass type (plan label, else template name) and its rule. */
export const ScanAdmitSchema = z.object({
  type: z.string(),
  rule: ScanAdmitRuleSchema.nullable(),
  timeZone: TimeZoneSchema,
});
export type ScanAdmit = z.infer<typeof ScanAdmitSchema>;
