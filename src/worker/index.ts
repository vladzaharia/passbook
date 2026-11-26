import { createApp } from './app.ts';
import { handleScheduled } from './jobs/cron.ts';
import { handleQueue } from './jobs/queue.ts';
import { e2eReleaseControl, openE2eRelease } from './modules/wallet-providers/e2e-release.ts';
import type { AppEnv } from './platform/env.ts';
import { reportUnsupportedPatterns } from './platform/pattern-report.ts';
import { createAuthStores } from './stores.ts';

export { ScanHub } from './modules/scan/scan-hub.ts';
export { Broadcast } from './workflows/broadcast.ts';
export { BulkReissue } from './workflows/bulk-reissue.ts';
export { ChannelApply } from './workflows/channel-apply.ts';
export { ConnectionSync } from './workflows/connection-sync.ts';
export { IdentityProvision } from './workflows/identity-provision.ts';
export { OrgExport } from './workflows/org-export.ts';
export { OrgPurge } from './workflows/org-purge.ts';
export { PassImport } from './workflows/pass-import.ts';
export { TemplateImport } from './workflows/template-import.ts';

reportUnsupportedPatterns();
// e2e builds only; every other build compiles this to nothing (docs/design/wallet-providers/e2e-release.md).
openE2eRelease();

/** Holds routes only. Stores are built from each request's env inside the app. */
let app: ReturnType<typeof createApp> | undefined;

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const control = await e2eReleaseControl(request, env);
    if (control) return control;
    app ??= createApp({ stores: createAuthStores, hostPolicy: true });
    return app.fetch(request, env, ctx);
  },
  // Serves wallet-jobs, its DLQ and wallet-webhooks (separate queue so tenant receivers never delay push or email).
  queue: (batch: MessageBatch<unknown>, env: AppEnv, ctx: ExecutionContext) =>
    handleQueue(batch, env, ctx),
  scheduled: (controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) =>
    handleScheduled(controller, env, ctx),
} satisfies ExportedHandler<AppEnv>;
