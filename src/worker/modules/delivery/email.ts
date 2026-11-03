import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import { passSummary } from '../../email/pass-summary.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { currentPassJson, getOrg, getPass } from '../passes/repo.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { claimOrSettle, retryOrGiveUp } from './push.ts';
import { finishOutbox, orgBranding, setProviderId } from './repo.ts';

/** A failure that retrying cannot fix. */
class PermanentEmailError extends Error {}

export async function deliverEmail(ctx: ServiceContext, outboxId: string): Promise<void> {
  const db = ctx.env.DB;
  const claimed = await claimOrSettle(ctx, outboxId);
  if (!claimed) return;
  const { row, lease } = claimed;
  const now = ctx.clock.now();
  const pass = row.passId ? await getPass(db, row.passId) : null;
  const to = typeof row.payload.to === 'string' ? row.payload.to : null;
  if (!pass || !to) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, pass ? 'NO_RECIPIENT' : 'PASS_GONE');
    return;
  }
  if (!(await isOrgActive(ctx, pass.orgId))) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    return;
  }
  if (row.providerId) {
    // An earlier run sent the message but could not finish the row.
    await finishOutbox(db, row.id, lease, 'sent', now, null, row.providerId);
    return;
  }
  const attach = row.payload.attach === true;
  const org = await getOrg(db, pass.orgId);
  const base = baseUrl(ctx.env);
  const [platform, orgSettings, branding, rawPassJson] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, pass.orgId),
    orgBranding(db, pass.orgId),
    currentPassJson(db, pass.id),
  ]);
  const passJson = parseStoredPassJson(rawPassJson);
  const email = renderPassEmail({
    orgName: org?.name ?? 'PassBook',
    supportEmail: orgSettings['support.email'] ?? branding.supportEmail,
    supportUrl: orgSettings['support.url'] ?? branding.supportUrl,
    downloadUrl: `${base}/p/${pass.downloadToken}/pass.pkpass`,
    manageUrl: `${base}/p/${pass.downloadToken}`,
    badgeUrl: emailAssetUrl(base, '/apple/badge/en/black@2x.png'),
    attached: attach,
    passTitle:
      pass.displayTitle ?? (typeof passJson.description === 'string' ? passJson.description : null),
    summary: passSummary(passJson, { now: new Date(now) }),
    senderName: platform['email.senderName'],
    buddyBase: orgSettings['email.buddy'] ? base : null,
  });
  const event = (outcome: 'ok' | 'failed') =>
    writeEvent(ctx.env, {
      event: 'email.result',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: pass.identityId,
      outcome,
    });
  let messageId: string;
  try {
    let attachments: { filename: string; type: string; content: Uint8Array }[] | undefined;
    if (attach) {
      const object = await ctx.env.BUCKET.get(pass.objectKey);
      if (!object) throw new PermanentEmailError('Pass object is missing.');
      attachments = [
        {
          filename: 'pass.pkpass',
          type: 'application/vnd.apple.pkpass',
          content: new Uint8Array(await object.arrayBuffer()),
        },
      ];
    }
    ({ messageId } = await depsOf(ctx.env).mailer.send({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: email.fromName ?? platform['email.senderName'],
      ...(attachments ? { attachments } : {}),
    }));
  } catch (error) {
    event('failed');
    if (error instanceof PermanentEmailError) {
      ctx.log.warn('email.send_failed', { outboxId: row.id, code: 'EMAIL_PERMANENT', error });
      await finishOutbox(db, row.id, lease, 'failed', ctx.clock.now(), 'EMAIL_PERMANENT');
      return;
    }
    ctx.log.warn('email.send_failed', { outboxId: row.id, attempts: row.attempts, error });
    await retryOrGiveUp(ctx, row, lease, 'EMAIL_FAILED', 'failed');
    return;
  }
  event('ok');
  // The provider has the message. A bookkeeping failure must not cause a second send: the
  // provider id is kept so a lease-expiry re-run only finishes the row.
  try {
    await finishOutbox(db, row.id, lease, 'sent', ctx.clock.now(), null, messageId);
  } catch (error) {
    ctx.log.error('email.finish_failed', { outboxId: row.id, code: 'EMAIL_FINISH', error });
    await setProviderId(db, row.id, lease, messageId).catch((inner: unknown) =>
      ctx.log.error('email.finish_failed', {
        outboxId: row.id,
        code: 'EMAIL_PROVIDER_ID',
        error: inner,
      }),
    );
  }
}
