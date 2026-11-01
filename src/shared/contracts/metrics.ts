import { z } from 'zod';
import { IdSchema } from './common.ts';

export const MetricsQuerySchema = z.object({
  orgId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  range: z.enum(['24h', '7d', '30d']).default('7d'),
});
export const SeriesPointSchema = z.object({ t: z.number().int(), v: z.number() });
const series = z.array(SeriesPointSchema);

export const MetricsOverviewSchema = z.object({
  /** Which backend answered. d1 is the fallback and cannot count downloads. */
  source: z.enum(['analytics_engine', 'd1']),
  range: z.enum(['24h', '7d', '30d']),
  /** Bucket size of the series in ms. */
  bucketMs: z.number().int(),
  /** Series the active source cannot provide; they are zero. */
  unavailable: z.array(z.string()),
  totals: z.object({
    passes: z.number().int(),
    activePasses: z.number().int(),
    voidedPasses: z.number().int(),
    holders: z.number().int(),
    devices: z.number().int(),
    issued: z.number().int(),
    updated: z.number().int(),
    downloads: z.number().int(),
    registrations: z.number().int(),
    refreshes: z.number().int(),
    pushes: z.number().int(),
    pushFailures: z.number().int(),
    emails: z.number().int(),
    emailFailures: z.number().int(),
    syncRuns: z.number().int(),
    signIns: z.number().int(),
  }),
  series: z.object({
    issued: series,
    updated: series,
    downloads: series,
    registrations: series,
    refreshes: series,
    pushes: series,
    pushFailures: series,
    emails: series,
    emailFailures: series,
    syncRuns: series,
    signIns: series,
  }),
  /** First-run checklist counts. Platform-wide whatever the scope: the checklist is for a new platform. */
  setup: z.object({
    orgs: z.number().int(),
    /** Templates assigned to an organization. */
    assignedTemplates: z.number().int(),
    passes: z.number().int(),
    /** Pass emails the outbox delivered. */
    passEmailsSent: z.number().int(),
    /** The newest pass, for "Send it to a holder". */
    latestPassId: IdSchema.nullable(),
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
export type MetricsOverview = z.infer<typeof MetricsOverviewSchema>;
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;
export type SeriesKey = keyof MetricsOverview['series'];
