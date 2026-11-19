import { handleAppleBump } from '../modules/channels/jobs.ts';
import { handleConnectionWebhook, handlePassRefresh } from '../modules/connections/jobs.ts';
import { handleEmailSend, handlePushDeliver } from '../modules/delivery/jobs.ts';
import { handleJoinResend } from '../modules/join/jobs.ts';
import { handleHolderMail } from '../modules/me/jobs.ts';
import { handleMessageRuleCheck } from '../modules/message-rules/jobs.ts';
import { handlePrintsBulk } from '../modules/prints/jobs.ts';
import { handleRetentionNotice } from '../modules/retention/jobs.ts';
import { handleForkUpdate } from '../modules/templates/fork-updates-job.ts';
import { handleCredentialCheck } from '../modules/wallet-providers/account-check-job.ts';
import { handleCredentialMigrate } from '../modules/wallet-providers/credential-migrate-job.ts';
import { handleEnrolmentHold } from '../modules/wallet-providers/enrolment-hold-job.ts';
import { handleWebhookDeliver } from '../modules/webhooks/jobs.ts';
import type { ServiceContext } from '../platform/service-context.ts';
import type { Job, JobKind, JobOf } from './types.ts';

export type JobHandler<K extends JobKind> = (job: JobOf<K>, ctx: ServiceContext) => Promise<void>;

/** kind -> handler. The owning module implements the handler; this table is the only router. */
export const JOB_HANDLERS: { [K in JobKind]: JobHandler<K> } = {
  'push.deliver': handlePushDeliver,
  'email.send': handleEmailSend,
  'join.resend': handleJoinResend,
  'message_rule.check': handleMessageRuleCheck,
  'pass.holder_mail': handleHolderMail,
  'retention.notice': handleRetentionNotice,
  'pass.refresh': handlePassRefresh,
  'connection.webhook': handleConnectionWebhook,
  'webhook.deliver': handleWebhookDeliver,
  'template.fork_update': handleForkUpdate,
  'wallet.enrolment_hold': handleEnrolmentHold,
  'wallet.credential_migrate': handleCredentialMigrate,
  'wallet.credential_check': handleCredentialCheck,
  'channel.apple_bump': handleAppleBump,
  'prints.bulk': handlePrintsBulk,
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
    case 'message_rule.check':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'pass.holder_mail':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'retention.notice':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'pass.refresh':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'connection.webhook':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'webhook.deliver':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'template.fork_update':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'wallet.enrolment_hold':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'wallet.credential_migrate':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'wallet.credential_check':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'channel.apple_bump':
      return JOB_HANDLERS[job.kind](job, ctx);
    case 'prints.bulk':
      return JOB_HANDLERS[job.kind](job, ctx);
  }
}
