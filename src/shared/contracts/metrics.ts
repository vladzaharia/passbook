import { z } from 'zod';
import { IdSchema } from './common.ts';

export const MetricsQuerySchema = z.object({
  orgId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  range: z.enum(['24h', '7d', '30d']).default('7d'),
});
export const SeriesPointSchema = z.object({ t: z.number().int(), v: z.number() });
export const MetricsOverviewSchema = z.object({
  source: z.enum(['analytics_engine', 'd1']),
  range: z.enum(['24h', '7d', '30d']),
  totals: z.object({
    passes: z.number().int(),
    activePasses: z.number().int(),
    voidedPasses: z.number().int(),
    holders: z.number().int(),
    devices: z.number().int(),
    issued: z.number().int(),
    updated: z.number().int(),
    downloads: z.number().int(),
    pushFailures: z.number().int(),
  }),
  series: z.object({
    issued: z.array(SeriesPointSchema),
    updated: z.array(SeriesPointSchema),
    downloads: z.array(SeriesPointSchema),
    pushes: z.array(SeriesPointSchema),
  }),
  recent: z.array(
    z.object({
      at: z.number().int(),
      action: z.string(),
      orgId: IdSchema.nullable(),
      targetId: z.string().nullable(),
    }),
  ),
});
