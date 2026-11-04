import { createApp } from './app.ts';
import { handleScheduled } from './jobs/cron.ts';
import { handleQueue } from './jobs/queue.ts';
import type { AppEnv } from './platform/env.ts';
import { createAuthStores } from './stores.ts';

export { BulkReissue } from './workflows/bulk-reissue.ts';
export { ConnectionSync } from './workflows/connection-sync.ts';
export { TemplateImport } from './workflows/template-import.ts';

/** Holds routes only. Stores are built from each request's env inside the app. */
let app: ReturnType<typeof createApp> | undefined;

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    app ??= createApp({ stores: createAuthStores, hostPolicy: true });
    return app.fetch(request, env, ctx);
  },
  queue: (batch: MessageBatch<unknown>, env: AppEnv, ctx: ExecutionContext) =>
    handleQueue(batch, env, ctx),
  scheduled: (controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) =>
    handleScheduled(controller, env, ctx),
} satisfies ExportedHandler<AppEnv>;
