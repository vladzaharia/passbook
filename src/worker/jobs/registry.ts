import { handleConnectionWebhook, handlePassRefresh } from '../modules/connections/jobs.ts';
import { handleEmailSend, handlePushDeliver } from '../modules/delivery/jobs.ts';
import { handleJoinResend } from '../modules/join/jobs.ts';
import { handleForkUpdate } from '../modules/templates/fork-updates-job.ts';
import { handleWebhookDeliver } from '../modules/webhooks/jobs.ts';
import type { ServiceContext } from '../platform/service-context.ts';
import type { Job, JobKind, JobOf } from './types.ts';

export type JobHandler<K extends JobKind> = (job: JobOf<K>, ctx: ServiceContext) => Promise<void>;

/** kind -> handler. The owning module implements the handler; this table is the only router. */
export const JOB_HANDLERS: { [K in JobKind]: JobHandler<K> } = {
  'push.deliver': handlePushDeliver,
  'email.send': handleEmailSend,
  'join.resend': handleJoinResend,
  'pass.refresh': handlePassRefresh,
  'connection.webhook': handleConnectionWebhook,
  'webhook.deliver': handleWebhookDeliver,
  'template.fork_update': handleForkUpdate,
};

/** Narrows per kind through a switch, so no cast is needed at the dispatch site. */
export function runJob(job: Job, ctx: ServiceContext): Promise<void> {
  switch (job.kind) {
    case 'push.deliver':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'email.send':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'join.resend':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'pass.refresh':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'connection.webhook':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'webhook.deliver':
    case 'template.fork_update':
      return JOB_HANDLERS[job.kind](job, ctx);
  }
}
