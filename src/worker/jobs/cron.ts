import { dailyApple } from '../modules/apple/jobs.ts';
import { dailyAudit } from '../modules/audit/jobs.ts';
import { dailyAuth } from '../modules/auth/jobs.ts';
import { failStuckBroadcasts, startDueBroadcasts } from '../modules/broadcasts/start.ts';
import { dailyChannels, sweepChannelApply } from '../modules/channels/apply-start.ts';
import { sweepEntitlementJournal } from '../modules/channels/entitlement-sweep.ts';
import { dailyConnections, reconcileConnections } from '../modules/connections/jobs.ts';
import { dailyDelivery, sweepDelivery } from '../modules/delivery/jobs.ts';
import { dailyDeveloperSandbox } from '../modules/developer/jobs.ts';
import { minutelyRequestLogPurge } from '../modules/developer/request-log-jobs.ts';
import { dailyEvents } from '../modules/events/jobs.ts';
import { resumeVerifiedHolderAttachments } from '../modules/holders/transfer-jobs.ts';
import { dailyApnsProbe, dailyIdentities } from '../modules/identities/jobs.ts';
import { dailyRotationPlan } from '../modules/identities/rotation-plan.ts';
import { drainIdp, reconcileIdp } from '../modules/idp/jobs.ts';
import { dailyScimTokens } from '../modules/idp/scim-tokens.ts';
import { dailyJoin } from '../modules/join/jobs.ts';
import { rewrapEnvelopes } from '../modules/keys/rewrap.ts';
import { dailyMessageRules } from '../modules/message-rules/jobs.ts';
import { tickMessageRules } from '../modules/message-rules/tick.ts';
import { expireBindings } from '../modules/nfc/expiry.ts';
import { sweepStalledOperations } from '../modules/operations/stalls.ts';
import { sweepOperations } from '../modules/operations/sweep.ts';
import { dailyOrgLifecycle } from '../modules/org-lifecycle/jobs.ts';
import { sweepBrandingGc } from '../modules/orgs/branding-gc.ts';
import { expireEntitlementOverrides } from '../modules/orgs/entitlement-expiry.ts';
import { sweepBulkRuns } from '../modules/passes/bulk-run.ts';
import { resumePendingCredentialTransfers } from '../modules/passes/credential-transfer-resume.ts';
import { claimBoundaries } from '../modules/passes/event-boundaries.ts';
import { sweepIdentityMoves } from '../modules/passes/identity-move-sweep.ts';
import { dailyImports } from '../modules/passes/import-retention.ts';
import { sweepStuckImports } from '../modules/passes/import-sweep.ts';
import { dailyPasses } from '../modules/passes/jobs.ts';
import { sweepPassObjects } from '../modules/passes/orphan-gc.ts';
import { reissueStalePasses } from '../modules/passes/stale-reissue.ts';
import { remacCapabilityTokens } from '../modules/passes/token-remac.ts';
import { sweepTransferAssetGc } from '../modules/passes/transfer-asset-gc.ts';
import { sweepPrintPdfs } from '../modules/prints/pdf-sweep.ts';
import { dailyGuestPasses } from '../modules/retention/guest-passes.ts';
import { dailyPhotos, dailyReceipts } from '../modules/retention/jobs.ts';
import { dailySandbox, sweepSandboxForwards } from '../modules/sandbox/jobs.ts';
import { backfillScanLookups, dailyScans, reconcileScans } from '../modules/scan/jobs.ts';
import { autoTapOut } from '../modules/scan/occupancy/jobs.ts';
import { sweepSessionHours } from '../modules/scan/session-hours-job.ts';
import { recordCronRun } from '../modules/status/cron.ts';
import {
  failureCode,
  type HookOutcome,
  recordHookOutcomes,
} from '../modules/status/hook-health.ts';
import { pruneDlqOutcomes } from '../modules/status/repo-hooks.ts';
import { sweepForkOrphans } from '../modules/templates/fork-updates-gc.ts';
import { planForkUpdates } from '../modules/templates/fork-updates-plan.ts';
import { syncBakedOnDeploy } from '../modules/templates/jobs.ts';
import { usagePeriods } from '../modules/usage/jobs-periods.ts';
import { enqueueCredentialChecks } from '../modules/wallet-providers/account-check.ts';
import { syncGoogleClassReviews } from '../modules/wallet-providers/google-review-sync.ts';
import { dailyGoogleKeys } from '../modules/wallet-providers/sa-key-inventory.ts';
import { drainWalletProviderSync } from '../modules/wallet-providers/sync.ts';
import { dailyWebhooks, sweepWebhooks } from '../modules/webhooks/jobs.ts';
import { endUnclaimedCliTokens } from '../modules/workbench/cli-revoke.ts';
import { cronDevicePasses } from '../modules/workbench/device-pass-sync.ts';
import { sweepLeakedGrants } from '../platform/authority.ts';
import type { AppEnv } from '../platform/env.ts';
import { sweepIdempotency } from '../platform/idempotency.ts';
import { purgeRetiredIds } from '../platform/retired-ids.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';
import { CRON_QUERY_BUDGET, countQueries } from './query-counter.ts';

export type CronHook = (ctx: ServiceContext) => Promise<void>;

export const MINUTE_CRON = '* * * * *';
export const DAILY_CRON = '17 3 * * *';

/** Hooks run independently; one failing never blocks the others. Daily hooks share a query budget. */
export const CRON_HOOKS: Record<string, { name: string; run: CronHook }[]> = {
  [MINUTE_CRON]: [
    { name: 'delivery.sweep', run: sweepDelivery },
    { name: 'webhooks.sweep', run: sweepWebhooks },
    { name: 'sandbox.forwards', run: sweepSandboxForwards },
    { name: 'device_passes.sweep', run: cronDevicePasses },
    { name: 'connections.schedule', run: reconcileConnections },
    { name: 'templates.sync', run: syncBakedOnDeploy },
    { name: 'templates.fork_updates', run: (ctx) => planForkUpdates(ctx) },
    { name: 'passes.stale_reissue', run: reissueStalePasses },
    { name: 'passes.event_boundaries', run: claimBoundaries },
    { name: 'broadcasts.start', run: startDueBroadcasts },
    { name: 'broadcasts.stuck', run: failStuckBroadcasts },
    { name: 'channels.apply_sweep', run: sweepChannelApply },
    { name: 'entitlements.override_expiry', run: expireEntitlementOverrides },
    { name: 'entitlements.journal_sweep', run: sweepEntitlementJournal },
    { name: 'message_rules.tick', run: tickMessageRules },
    { name: 'scan.reconcile', run: reconcileScans },
    { name: 'scan.backfill', run: backfillScanLookups },
    { name: 'scan.occupancy', run: autoTapOut },
    { name: 'scan.session_hours', run: sweepSessionHours },
    { name: 'tokens.remac', run: remacCapabilityTokens },
    { name: 'keys.rewrap', run: rewrapEnvelopes },
    { name: 'wallet.sync', run: drainWalletProviderSync },
    { name: 'wallet.google_review', run: syncGoogleClassReviews },
    {
      name: 'passes.credential_transfers',
      run: async (ctx) => {
        await resumePendingCredentialTransfers(ctx);
        await resumeVerifiedHolderAttachments(ctx);
      },
    },
    { name: 'passes.transfer_asset_gc', run: sweepTransferAssetGc },
    { name: 'passes.import_stuck', run: sweepStuckImports },
    { name: 'passes.bulk_run_stuck', run: sweepBulkRuns },
    { name: 'passes.identity_moves', run: sweepIdentityMoves },
    { name: 'operations.stalls', run: sweepStalledOperations },
    { name: 'developer.request_log_purge', run: minutelyRequestLogPurge },
    { name: 'nfc.binding_expiry', run: async (ctx) => void (await expireBindings(ctx)) },
    { name: 'idp.drain', run: drainIdp },
    { name: 'usage.periods', run: usagePeriods },
  ],
  [DAILY_CRON]: [
    { name: 'authority.sweep', run: async (ctx) => void (await sweepLeakedGrants(ctx)) },
    { name: 'cli.unclaimed_tokens', run: async (ctx) => void (await endUnclaimedCliTokens(ctx)) },
    { name: 'authority.retired_ids', run: async (ctx) => void (await purgeRetiredIds(ctx)) },
    { name: 'passes.retention', run: dailyPasses },
    { name: 'passes.object_gc', run: (ctx) => sweepPassObjects(ctx) },
    { name: 'idempotency.sweep', run: sweepIdempotency },
    { name: 'operations.sweep', run: sweepOperations },
    { name: 'prints.pdf_sweep', run: sweepPrintPdfs },
    { name: 'passes.import_retention', run: dailyImports },
    { name: 'connections.retention', run: dailyConnections },
    { name: 'delivery.retention', run: dailyDelivery },
    { name: 'auth.retention', run: dailyAuth },
    { name: 'audit.retention', run: dailyAudit },
    { name: 'events.retention', run: dailyEvents },
    { name: 'dlq.retention', run: async (ctx) => pruneDlqOutcomes(ctx.env.DB, ctx.clock.now()) },
    { name: 'apple.retention', run: dailyApple },
    { name: 'identities.expiry', run: dailyIdentities },
    { name: 'identities.apns_probe', run: dailyApnsProbe },
    { name: 'identities.rotation_plan', run: dailyRotationPlan },
    { name: 'wallet.google_keys', run: dailyGoogleKeys },
    { name: 'wallet.credential_checks', run: enqueueCredentialChecks },
    { name: 'scan.retention', run: dailyScans },
    { name: 'join.retention', run: dailyJoin },
    { name: 'channels.retention', run: dailyChannels },
    { name: 'orgs.branding_gc', run: sweepBrandingGc },
    { name: 'webhooks.retention', run: dailyWebhooks },
    { name: 'templates.fork_orphans', run: sweepForkOrphans },
    { name: 'message_rules.retention', run: dailyMessageRules },
    { name: 'photos.retention', run: dailyPhotos },
    { name: 'org_lifecycle.sweep', run: dailyOrgLifecycle },
    { name: 'developer.idle_close', run: dailyDeveloperSandbox },
    { name: 'idp.reconcile', run: reconcileIdp },
    { name: 'idp.scim_tokens', run: dailyScimTokens },
    { name: 'retention.receipts', run: dailyReceipts },
    // Near the end: it spends what the other daily hooks left of the query budget.
    { name: 'retention.guest_passes', run: dailyGuestPasses },
    // Last: a backlog of test data must never starve the checks above.
    { name: 'sandbox.purge', run: dailySandbox },
  ],
};

export async function handleScheduled(
  controller: ScheduledController,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const hooks = CRON_HOOKS[controller.cron] ?? [];
  const base = createJobContext(env, 'cron', { ctx, base: { cron: controller.cron } });
  const hookCtx = (env: AppEnv, hook: string, queries?: () => number) =>
    createJobContext(env, 'cron', {
      ctx,
      base: { cron: controller.cron, hook },
      ...(queries ? { queries } : {}),
    });
  const failed = (hook: string, error: unknown) =>
    base.log.error('cron.hook_failed', { hook, code: 'CRON_HOOK_FAILED', error });
  const outcomes: HookOutcome[] = [];
  if (controller.cron === DAILY_CRON) {
    // Sequential under one query budget: a hook that would start past it is skipped until tomorrow.
    const counter = countQueries(env);
    for (const hook of hooks) {
      if (counter.count() >= CRON_QUERY_BUDGET) {
        base.log.warn('cron.budget_skipped', {
          hook: hook.name,
          code: 'CRON_BUDGET',
          queries: counter.count(),
        });
        continue;
      }
      try {
        await hook.run({ ...hookCtx(counter.env, hook.name, counter.count), spent: counter.count });
        outcomes.push({ hook: hook.name, failure: null });
      } catch (error) {
        outcomes.push({ hook: hook.name, failure: failureCode(error, 'CRON_HOOK_FAILED') });
        failed(hook.name, error);
      }
    }
  } else {
    // Transfer finalization must observe retirements accepted by this minute's wallet sync.
    // All other minute hooks remain independent, including when wallet sync fails.
    let walletSync: Promise<void> | undefined;
    const results = await Promise.allSettled(
      hooks.map((hook) => {
        const run = async () => {
          if (hook.name === 'passes.credential_transfers' && walletSync) {
            await walletSync.catch(() => {});
          }
          await hook.run(hookCtx(env, hook.name));
        };
        const result = run();
        if (hook.name === 'wallet.sync') walletSync = result;
        return result;
      }),
    );
    results.forEach((result, i) => {
      const hook = hooks[i]?.name ?? 'unknown';
      if (result.status === 'rejected') failed(hook, result.reason);
      outcomes.push({
        hook,
        failure:
          result.status === 'rejected' ? failureCode(result.reason, 'CRON_HOOK_FAILED') : null,
      });
    });
  }
  await recordHookOutcomes(base, controller.cron === DAILY_CRON ? 'daily' : 'minute', outcomes);
  if (controller.cron === MINUTE_CRON) {
    try {
      await recordCronRun(base, 'minute');
    } catch (error) {
      base.log.error('cron.record_failed', { code: 'CRON_RECORD_FAILED', error });
    }
  }
}
