import { pinOnlyOffEmail } from '../../email/pin-only-off.ts';
import { claim } from '../../platform/counters.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { readOrgAdminEmails } from '../retention/repo.ts';
import { orgNameOf } from './repo-pin-only.ts';

const DAY = 24 * 3_600_000;

/**
 * Tell every org admin that wrong PINs switched PIN-only off. At most one mail an org a day, so a
 * paired device cannot use it to flood admin inboxes. A failed send is logged, never raised.
 */
export async function mailPinOnlyOff(ctx: ServiceContext, orgId: string): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  if (!(await claim(db, `scan:pinonly-mail:${orgId}`, now - (now % DAY)))) return;
  const org = await orgNameOf(db, orgId);
  if (!org) return;
  const mail = pinOnlyOffEmail(baseUrl(ctx.env), org.name);
  const mailer = createEmailBindingMailer(ctx.env);
  let sent = 0;
  let failed = 0;
  for (const to of await readOrgAdminEmails(db, orgId)) {
    try {
      await mailer.send({ to, ...mail });
      sent++;
    } catch {
      // Provider errors can carry message content, so none is logged.
      failed++;
    }
  }
  // The day is claimed before the send, so a failed send is not retried today: the log says so.
  ctx.log[failed ? 'error' : 'info']('scan.pin_only_mail', {
    orgId,
    code: failed ? 'PIN_ONLY_MAIL_FAILED' : 'PIN_ONLY_MAIL',
    claimed: true,
    sent,
    failed,
  });
}
