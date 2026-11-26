import { z } from 'zod';
import { IdSchema, ModeSchema } from './common.ts';
import {
  WalletCredentialListSchema,
  WalletCredentialSchema,
  WalletProviderIssuanceSchema,
  WalletProviderSchema,
} from './wallet-providers.ts';

/** The platform release of a provider in a mode. `draining` is the rollback: voids and removals still flow. */
export const WalletReleaseStateSchema = z.enum(['dark', 'draining', 'released']);
export type WalletReleaseState = z.infer<typeof WalletReleaseStateSchema>;

/**
 * Why an enrolment is not ready for the release: the plan lacks the wallet (developer orgs included), a step of
 * enabling is missing (source, verified, check, round_trip), the platform holds it, it is revoked, the org blocked
 * the channel, or the org is not active. `org_off`: it was On and the org switched it Off; `hold_released`: a
 * platform hold cleared it. Only the org turns those back On. `legacy` is an envelope with no source: it would issue
 * with no enrolment, so a flip's deploy refuses while one exists (wallet-migration-gate).
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
  'org_off',
  'hold_released',
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

/**
 * A dry run unless `apply` is true. An apply names the orgs of the dry run it follows (`orgIds`) and is refused
 * (409) when the ready list differs; it also needs the provider released in the mode.
 */
export const EnableReadySchema = z
  .strictObject({
    apply: z.boolean().default(false),
    orgIds: z.array(IdSchema).max(1000).optional(),
  })
  .refine((v) => !v.apply || v.orgIds !== undefined, {
    message: 'An apply names the orgIds of its dry run.',
    path: ['orgIds'],
  });
export type EnableReady = z.infer<typeof EnableReadySchema>;

export const EnableReadyResultSchema = z.strictObject({
  applied: z.boolean(),
  /** The enrolments that are Off and ready: turned On when applied, else what an apply would turn On. */
  enrolments: z.array(z.strictObject({ orgId: IdSchema, orgName: z.string() })),
});
export type EnableReadyResult = z.infer<typeof EnableReadyResultSchema>;
||||||| 8955c9c48

const ReleaseByModeSchema = z.strictObject({
  live: WalletProviderIssuanceSchema,
  test: WalletProviderIssuanceSchema,
});
/** Release state per provider and mode: the platform pages say it where credentials are set. */
export const WalletReleaseSchema = z.strictObject({
  google: ReleaseByModeSchema,
  samsung: ReleaseByModeSchema,
});
export type WalletRelease = z.infer<typeof WalletReleaseSchema>;

export const PlatformWalletCredentialListSchema = WalletCredentialListSchema.extend({
  release: WalletReleaseSchema,
});
export type PlatformWalletCredentialList = z.infer<typeof PlatformWalletCredentialListSchema>;
