import { z } from 'zod';
import {
  CAPABILITY_IDS,
  ITEM_GROUPS,
  SUPPORT_LEVELS,
  WALLET_TARGETS,
} from '../../passkit/wallets/vocab.ts';

export const ReportStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('omissions'), count: z.number().int().positive() }),
  z.object({ kind: z.literal('blocked'), reason: z.string() }),
]);

export const ReportItemSchema = z.object({
  capability: z.enum(CAPABILITY_IDS),
  path: z.string(),
  support: z.enum(SUPPORT_LEVELS),
  severity: z.enum(['difference', 'omission', 'blocked']),
  group: z.enum(ITEM_GROUPS),
  chosen: z.boolean(),
  message: z.string(),
});

/** What `fidelityReport` returns; the API and the Wallets tab share it. */
export const FidelityReportSchema = z.object({
  schema: z.literal(1),
  target: z.enum(WALLET_TARGETS),
  type: z.string(),
  compilerRevision: z.number().int().nonnegative(),
  status: ReportStatusSchema,
  items: z.array(ReportItemSchema),
});
export type FidelityReportDto = z.infer<typeof FidelityReportSchema>;

/**
 * One report per native target for a template version: the import report and the Wallets tab
 * both read this shape.
 */
export const WalletReportsSchema = z.object({
  google: FidelityReportSchema,
  samsung: FidelityReportSchema,
});
export type WalletReportsDto = z.infer<typeof WalletReportsSchema>;
