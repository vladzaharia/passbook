import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { daysRemaining } from './expiry.ts';
import { autoIdentitiesExpiring, platformAdminEmails } from './repo-provision.ts';
import { latestRun } from './repo-runs.ts';

const DAY = 86_400_000;
/** Days to expiry: the first failure alert, then a daily email from 7 days until 30 days after expiry. */
export const FIRST_ALERT_DAYS = 45;
export const DAILY_ALERT_DAYS = 7;
const EXPIRED_GRACE_DAYS = 30;

interface AlertState {
  notAfter: number;
  first?: true;
  lastDay?: number;
}

const key = (id: string) => `identity_alert.${id}`;

/** Best effort: the audit row and log carry the failure. A mail failure is logged by code, never by address. */
export async function emailPlatformAdmins(
  ctx: ServiceContext,
  subject: string,
  text: string,
): Promise<void> {
  const mailer = createEmailBindingMailer(ctx.env);
  for (const to of await platformAdminEmails(ctx.env.DB)) {
    try {
      await mailer.send({ to, subject, text, html: `<p>${text}</p>` });
    } catch {
      // Provider errors can echo message content, so none is logged.
      ctx.log.error('identity.alert_mail_failed', { code: 'IDENTITY_ALERT_MAIL_FAILED' });
    }
  }
}

/**
 * The failure ladder of design 5.1 for auto identities the rotation has not replaced. Status turns amber
 * at 30 days and red at 14 on its own (`checks-identity.ts`). Here: the first alert at 45 days (audit,
 * error log, email), then one email a day from 7 days to expiry.
 */
export async function runRotationAlerts(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const today = Math.floor(now / DAY);
  for (const row of await autoIdentitiesExpiring(ctx.env.DB, now + FIRST_ALERT_DAYS * DAY)) {
    const days = daysRemaining(row.not_after, now) ?? 0;
    if (days < -EXPIRED_GRACE_DAYS) continue;
    const stored = (await readSystemValue(ctx.env.DB, key(row.id))) as AlertState | null;
    const state: AlertState =
      stored?.notAfter === row.not_after ? stored : { notAfter: row.not_after };
    const daily = days <= DAILY_ALERT_DAYS;
    if (daily ? state.lastDay === today : state.first) continue;

    const last = await latestRun(ctx.env.DB, 'identity', row.id, 'rotate');
    const reason = last?.error_code ?? last?.waiting_for ?? null;
    if (!state.first) {
      await recordAudit(ctx, {
        actorType: 'system',
        orgId: row.org_id,
        action: 'identity.rotation_overdue',
        targetType: 'identity',
        targetId: row.id,
        detail: { daysRemaining: days, reason, passTypeIdentifier: row.pass_type_identifier },
      });
      ctx.log.error('identity.rotation_overdue', {
        identityId: row.id,
        days,
        reason,
        code: 'IDENTITY_ROTATION_FAILED',
      });
    }
    await emailPlatformAdmins(
      ctx,
      `Renew ${row.pass_type_identifier}`,
      `The certificate for ${row.pass_type_identifier} ${days < 0 ? 'has expired' : `expires in ${days} days`} and automatic renewal has not replaced it${reason ? ` (${reason})` : ''}. Renew it manually in Platform > Identities.`,
    );
    await writeSystemValue(
      ctx.env.DB,
      key(row.id),
      { notAfter: row.not_after, first: true, ...(daily ? { lastDay: today } : {}) },
      now,
    );
  }
}
