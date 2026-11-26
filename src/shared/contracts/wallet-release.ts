import { z } from 'zod';
import { IdSchema, ModeSchema } from './common.ts';
import { WalletCredentialSchema, WalletProviderSchema } from './wallet-providers.ts';

/** The platform release of a provider in a mode. `draining` is the rollback: voids and removals still flow. */
export const WalletReleaseStateSchema = z.enum(['dark', 'draining', 'released']);
export type WalletReleaseState = z.infer<typeof WalletReleaseStateSchema>;

/**
 * Why an enrolment would not issue once released: the plan lacks the wallet (developer orgs included), a step of
 * enabling is missing (source, verified, check, round_trip), the platform holds it, it is revoked, it is a legacy
 * envelope with no source, the org blocked the channel, or the org is not active.
 */
export const WalletReleaseBlockSchema = z.enum([
  'plan',
  'source',
  'verified',
  'check',
  'round_trip',
  'hold',
  'revoked',
  'legacy',
  'channel_off',
  'org',
]);
export type WalletReleaseBlock = z.infer<typeof WalletReleaseBlockSchema>;

/** `issuing`: On, issues once released. `ready`: Off, and enable-ready would turn it On. `blocked`: see `blocks`. */
export const WalletReleaseEnrolmentSchema = z.strictObject({
  orgId: IdSchema,
  orgName: z.string(),
  status: z.enum(['issuing', 'ready', 'blocked']),
  blocks: z.array(WalletReleaseBlockSchema),
});
export type WalletReleaseEnrolment = z.infer<typeof WalletReleaseEnrolmentSchema>;

const count = z.number().int().nonnegative();

/** One provider in one mode, as the owner reads it before a flip. */
export const WalletReleaseModeSchema = z.strictObject({
  provider: WalletProviderSchema,
  mode: ModeSchema,
  state: WalletReleaseStateSchema,
  /** The platform's own credentials for this provider and mode, not revoked, with their newest check. */
  credentials: z.array(WalletCredentialSchema),
  enrolments: z.array(WalletReleaseEnrolmentSchema),
  /** Org templates with an Apple release in this mode, by their provider release. */
  templates: z.strictObject({
    ready: count,
    withOmissions: count,
    awaitingReview: count,
    none: count,
  }),
  /** Provider copies: `open` must reach 0 before the release can go back to dark. */
  instances: z.strictObject({ open: count, retired: count }),
});
export type WalletReleaseMode = z.infer<typeof WalletReleaseModeSchema>;

export const WalletReleaseReportSchema = z.strictObject({
  releases: z.array(WalletReleaseModeSchema),
});
export type WalletReleaseReport = z.infer<typeof WalletReleaseReportSchema>;

export const WalletReleaseParamsSchema = z.strictObject({
  provider: WalletProviderSchema,
  mode: ModeSchema,
});

/** A dry run unless `apply` is true; applying needs the provider released in the mode. */
export const EnableReadySchema = z.strictObject({ apply: z.boolean().default(false) });
export type EnableReady = z.infer<typeof EnableReadySchema>;

export const EnableReadyResultSchema = z.strictObject({
  applied: z.boolean(),
  /** The enrolments that are Off and ready: turned On when applied, else what an apply would turn On. */
  enrolments: z.array(z.strictObject({ orgId: IdSchema, orgName: z.string() })),
});
export type EnableReadyResult = z.infer<typeof EnableReadyResultSchema>;
