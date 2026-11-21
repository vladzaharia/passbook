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
    emailUnknown: z.number().int().default(0),
    syncRuns: z.number().int(),
    signIns: z.number().int(),
    /** Scans of every outcome, and the refused ones among them. Zero until the scan module reports. */
    scans: z.number().int(),
    scanRefused: z.number().int(),
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
    emailUnknown: series.default([]),
    syncRuns: series,
    signIns: series,
    scans: series,
  }),
  /** First-run checklist counts. Platform-wide whatever the scope: the checklist is for a new platform. */
  setup: z.object({
    orgs: z.number().int(),
    /** Templates assigned to an organization. */
    assignedTemplates: z.number().int(),
    /** Test and Live passes. */
    passes: z.number().int(),
    /** Templates with an approved release in this mode. */
    approvedTemplates: z.number().int(),
    /** Templates with a Live release. */
    releasedTemplates: z.number().int(),
    /** Test and Live passes registered on at least one device: in a Wallet. */
    walletPasses: z.number().int(),
    /** Pass emails the outbox delivered. */
    passEmailsSent: z.number().int(),
    /** The newest pass, for "Send it to a holder". */
    latestPassId: IdSchema.nullable(),
    /** Paired or created scanners, for the checklist. */
    scanners: z.number().int(),
  }),
  /** Platform overview only: the directory cards. Follows the organization filter. */
  directory: z
    .object({
      /** Platform users, or the members of the filtered organization. */
      users: z.number().int(),
      /** Signing identities plus active Google and Samsung credentials, as the Wallet accounts page lists them. */
      walletAccounts: z.number().int(),
    })
    .optional(),
  /** Events that are open now, at most 3. */
  live: z
    .array(
      z.object({
        eventId: IdSchema,
        name: z.string(),
        arrived: z.number().int(),
        expected: z.number().int(),
        ratePerMin: z.number(),
      }),
    )
    .max(3),
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

/** One template's counts for an organization. Ranged counts cover the query range; the rest are now. */
export const TemplateActivitySchema = z.object({
  templateId: IdSchema,
  name: z.string(),
  issued: z.number().int(),
  /** Passes first put in a wallet in the range. */
  added: z.number().int(),
  removed: z.number().int(),
  scans: z.number().int(),
  redemptions: z.number().int(),
  /** Active passes on at least one device, now. */
  inWallet: z.number().int(),
  /** Active, unremoved passes on no device, now. */
  notAdded: z.number().int(),
});

/** An organization's activity by template. */
export const OrgActivitySchema = z.object({
  range: z.enum(['24h', '7d', '30d']),
  bucketMs: z.number().int(),
  totals: TemplateActivitySchema.omit({ templateId: true, name: true }),
  series: z.object({ issued: series, scans: series }),
  templates: z.array(TemplateActivitySchema),
});
export type OrgActivity = z.infer<typeof OrgActivitySchema>;
export type TemplateActivity = z.infer<typeof TemplateActivitySchema>;
