import { handleConnectionWebhook, handlePassRefresh } from '../modules/connections/jobs.ts';
import { handleEmailSend, handlePushDeliver } from '../modules/delivery/jobs.ts';
import type { ServiceContext } from '../platform/service-context.ts';
import type { JobKind, JobOf } from './types.ts';

export type JobHandler<K extends JobKind> = (job: JobOf<K>, ctx: ServiceContext) => Promise<void>;

/** kind -> handler. The owning module implements the handler; this table is the only router. */
export const JOB_HANDLERS: { [K in JobKind]: JobHandler<K> } = {
  'push.deliver': handlePushDeliver,
  'email.send': handleEmailSend,
  'pass.refresh': handlePassRefresh,
  'connection.webhook': handleConnectionWebhook,
};
