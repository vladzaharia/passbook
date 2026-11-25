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
import { dailyJoin } from '../modules/join/jobs.ts';
import { rewrapEnvelopes } from '../modules/keys/rewrap.ts';
import { dailyMessageRules } from '../modules/message-rules/jobs.ts';
import { tickMessageRules } from '../modules/message-rules/tick.ts';
import { expireBindings } from '../modules/nfc/expiry.ts';
import { dailyOrgLifecycle } from '../modules/org-lifecycle/jobs.ts';
import { sweepBrandingGc } from '../modules/orgs/branding-gc.ts';
import { expireEntitlementOverrides } from '../modules/orgs/entitlement-expiry.ts';
import { sweepBulkRuns } from '../modules/passes/bulk-run.ts';
import { resumePendingCredentialTransfers } from '../modules/passes/credential-transfer-resume.ts';
import { dailyImports } from '../modules/passes/import-retention.ts';
import { sweepStuckImports } from '../modules/passes/import-sweep.ts';
import { dailyPasses } from '../modules/passes/jobs.ts';
import { reissueStalePasses } from '../modules/passes/stale-reissue.ts';
import { remacCapabilityTokens } from '../modules/passes/token-remac.ts';
import { sweepTransferAssetGc } from '../modules/passes/transfer-asset-gc.ts';
import { sweepPrintPdfs } from '../modules/prints/pdf-sweep.ts';
import { dailyPhotos, dailyReceipts } from '../modules/retention/jobs.ts';
import { dailySandbox, sweepSandboxForwards } from '../modules/sandbox/jobs.ts';
import { backfillScanLookups, dailyScans, reconcileScans } from '../modules/scan/jobs.ts';
import { autoTapOut } from '../modules/scan/occupancy/jobs.ts';
import { sweepSessionHours } from '../modules/scan/session-hours-job.ts';
import { recordCronRun } from '../modules/status/cron.ts';
import { sweepForkOrphans } from '../modules/templates/fork-updates-gc.ts';
import { planForkUpdates } from '../modules/templates/fork-updates-plan.ts';
import { syncBakedOnDeploy } from '../modules/templates/jobs.ts';
import { enqueueCredentialChecks } from '../modules/wallet-providers/account-check.ts';
import { dailyGoogleKeys } from '../modules/wallet-providers/sa-key-inventory.ts';
import { drainWalletProviderSync } from '../modules/wallet-providers/sync.ts';
import { dailyWebhooks, sweepWebhooks } from '../modules/webhooks/jobs.ts';
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
    { name: 'connections.schedule', run: reconcileConnections },
    { name: 'templates.sync', run: syncBakedOnDeploy },
    { name: 'templates.fork_updates', run: (ctx) => planForkUpdates(ctx) },
    { name: 'passes.stale_reissue', run: reissueStalePasses },
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
    { name: 'developer.request_log_purge', run: minutelyRequestLogPurge },
    { name: 'nfc.binding_expiry', run: async (ctx) => void (await expireBindings(ctx)) },
  ],
  [DAILY_CRON]: [
    { name: 'authority.sweep', run: async (ctx) => void (await sweepLeakedGrants(ctx)) },
    { name: 'authority.retired_ids', run: async (ctx) => void (await purgeRetiredIds(ctx)) },
    { name: 'passes.retention', run: dailyPasses },
    { name: 'idempotency.sweep', run: sweepIdempotency },
    { name: 'prints.pdf_sweep', run: sweepPrintPdfs },
    { name: 'passes.import_retention', run: dailyImports },
    { name: 'connections.retention', run: dailyConnections },
    { name: 'delivery.retention', run: dailyDelivery },
    { name: 'auth.retention', run: dailyAuth },
    { name: 'audit.retention', run: dailyAudit },
    { name: 'events.retention', run: dailyEvents },
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
    { name: 'retention.receipts', run: dailyReceipts },
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
  const hookCtx = (env: AppEnv, hook: string) =>
    createJobContext(env, 'cron', { ctx, base: { cron: controller.cron, hook } });
  const failed = (hook: string, error: unknown) =>
    base.log.error('cron.hook_failed', { hook, code: 'CRON_HOOK_FAILED', error });
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
        await hook.run(hookCtx(counter.env, hook.name));
      } catch (error) {
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
      if (result.status === 'rejected') failed(hooks[i]?.name ?? 'unknown', result.reason);
    });
  }
  if (controller.cron === MINUTE_CRON) {
    try {
      await recordCronRun(base, 'minute');
    } catch (error) {
      base.log.error('cron.record_failed', { code: 'CRON_RECORD_FAILED', error });
    }
  }
}
