import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * A duplicate submit answers "Check your email" and queues this job: the job re-reads the pass and mails
 * its card to the address on it. The browser never sees the card; whether mail went out changes nothing on the page.
 */
export async function queueResend(
  ctx: ServiceContext,
  passId: string,
  linkId: string,
): Promise<void> {
  await ctx.env.JOBS.send({ kind: 'join.resend', passId, linkId });
}
