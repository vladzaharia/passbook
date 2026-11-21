import { pinDigestEmail } from '../../email/pin-digest.ts';
import { claim } from '../../platform/counters.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { readOrgAdminEmails } from '../retention/repo.ts';
import { orgNameOf } from './repo-pin-only.ts';
import { digestEvents } from './repo-pin-tag.ts';

const DAY = 24 * 3_600_000;
const MAX_LINES = 20;

const lineOf = (e: { action: string; person: string | null; scanner: string | null }) =>
  e.action === 'scan_staff.pin_shared'
    ? `${e.person ?? 'Someone'} has a PIN someone else has (seen on ${e.scanner ?? 'a scanner'}).`
    : e.action === 'scan_staff.pin_self_reset'
      ? `${e.person ?? 'Someone'} was given a new PIN on ${e.scanner ?? 'a scanner'}.`
      : 'Wrong named PINs reached the daily limit for the organization.';

/**
 * Daily, for the day before: one mail per org to its admins naming who had a shared PIN or was given
 * a new one, and on which scanner. The day is claimed per org before the send, so a repeat run cannot
 * send twice; the log carries the claim and the outcome together.
 */
export async function dailyPinDigest(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const today = now - (now % DAY);
  const events = await digestEvents(db, today - DAY, today);
  const byOrg = Map.groupBy(events, (e) => e.org_id);
  for (const [orgId, rows] of byOrg) {
    if (!(await claim(db, `scan:pindigest:${orgId}`, today))) continue;
    const org = await orgNameOf(db, orgId);
    if (!org) continue;
    // One line per person and kind: a repeat in the day adds nothing.
    const lines = [...new Set(rows.map(lineOf))].slice(0, MAX_LINES);
    const mail = pinDigestEmail(baseUrl(ctx.env), org.name, lines);
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
    ctx.log[failed ? 'error' : 'info']('scan.pin_digest', {
      orgId,
      code: failed ? 'PIN_DIGEST_FAILED' : 'PIN_DIGEST',
      claimed: true,
      events: rows.length,
      sent,
      failed,
    });
  }
}
