import type { JobOf } from '../../jobs/types.ts';
import { jobGrant } from '../../platform/authority.ts';
import { isNotNull, lt } from '../../platform/authority-expr.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { getPass } from '../passes/repo-read-pass.ts';

const HOUR = 60 * 60 * 1000;
/** The network, device and field digests of a join card are kept this long. */
export const KEY_TTL_MS = 48 * HOUR;

/** Mails an existing card to the address it holds, as the system. Refusals are logged and dropped, never retried. */
export async function handleJoinResend(
  job: JobOf<'join.resend'>,
  ctx: ServiceContext,
): Promise<void> {
  const pass = await getPass(ctx.env.DB, job.passId);
  const to = pass?.holderEmail;
  if (!pass || !to || pass.status !== 'active' || pass.removedAt !== null) {
    ctx.log.info('join.resend_skipped', { linkId: job.linkId, code: 'JOIN_RESEND_SKIPPED' });
    return;
  }
  try {
    await enqueuePassEmail(ctx, {
      passId: pass.id,
      to,
      attach: false,
      expected: pass,
      joined: true,
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    const code = error.code === 'EMAIL_RATE_LIMITED' ? 'JOIN_EMAIL_CAPPED' : 'JOIN_RESEND_REFUSED';
    ctx.log.warn('join.resend_refused', { linkId: job.linkId, orgId: pass.orgId, code });
  }
}

/** Daily: the digests of cards older than 48 hours are cleared; the rows stay for the caps and go with their pass. */
export async function dailyJoin(ctx: ServiceContext): Promise<void> {
  const g = jobGrant(ctx, { job: 'join-retention', purpose: 'platform.job.join_clear_keys' });
  const before = ctx.clock.now() - KEY_TTL_MS;
  for (const column of ['ip_key', 'device_key', 'fields_hash'])
    g.update('join_issues', {
      set: { [column]: null },
      where: { created_at: lt(before), [column]: isNotNull() },
    });
  const results = await g.commit();
  ctx.log.info('join.retention', { cleared: results.map((r) => r.meta.changes ?? 0) });
}
