import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import { passEmailImages } from '../../email/pass-images.ts';
import { passSummary } from '../../email/pass-summary.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { deliverBundleEmail } from '../bundles/deliver.ts';
import { recordPassEvent } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { currentPassJson, getOrg, getPass } from '../passes/repo.ts';
import { passImages } from '../public/service.ts';
import { captureEmail } from '../sandbox/capture.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { finishSent } from './email-finish.ts';
import { claimOrSettle, retryOrGiveUp } from './push.ts';
import { finishOutbox, orgBranding } from './repo.ts';

/** A failure that retrying cannot fix. */
class PermanentEmailError extends Error {}

export async function deliverEmail(ctx: ServiceContext, outboxId: string): Promise<void> {
  const db = ctx.env.DB;
  const claimed = await claimOrSettle(ctx, outboxId);
  if (!claimed) return;
  const { row, lease } = claimed;
  const now = ctx.clock.now();
  if (typeof row.payload.bundleId === 'string') {
    // The row hangs on the bundle's first pass, but a deleted pass must not cancel the bundle:
    // deliverBundleEmail picks the first live member.
    const bundleTo = typeof row.payload.to === 'string' ? row.payload.to : null;
    if (!bundleTo) await finishOutbox(db, row.id, lease, 'cancelled', now, 'NO_RECIPIENT');
    else if (!(await isOrgActive(ctx, row.orgId)))
      await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    else await deliverBundleEmail(ctx, { row, lease, to: bundleTo });
    return;
  }
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
  const [platform, orgSettings, branding, rawPassJson, images] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, pass.orgId),
    orgBranding(db, pass.orgId),
    currentPassJson(db, pass.id),
    // Without them the email still goes, with the org's name and no pass art.
    passImages(ctx, pass).catch((error: unknown) => {
      ctx.log.warn('email.images_failed', { outboxId: row.id, code: 'EMAIL_IMAGES', error });
      return [];
    }),
  ]);
  const passJson = parseStoredPassJson(rawPassJson);
  const { iconUrl, logo } = passEmailImages(images, base);
  const email = renderPassEmail({
    orgName: org?.name ?? 'PassBook',
    ...emailSupport(ctx.env, orgSettings, branding),
    downloadUrl: `${base}/p/${pass.downloadToken}/pass.pkpass`,
    manageUrl: `${base}/p/${pass.downloadToken}`,
    badgeUrl: emailAssetUrl(base, EMAIL_BADGE.path),
    attached: attach,
    passTitle:
      pass.displayTitle ?? (typeof passJson.description === 'string' ? passJson.description : null),
    summary: passSummary(passJson, { now: new Date(now) }),
    iconUrl,
    logo,
    logoText:
      branding.logoHasName || typeof passJson.logoText !== 'string' ? null : passJson.logoText,
    senderName: platform['email.senderName'],
    buddyBase: orgSettings['email.buddy'] ? base : null,
  });
  if (pass.mode === 'test') {
    await captureEmail(ctx, {
      row,
      lease,
      orgId: pass.orgId,
      eventPassId: pass.id,
      passId: pass.id,
      to,
      email,
      attached: attach,
    });
    return;
  }
  const event = async (outcome: 'ok' | 'failed', code?: string) => {
    writeEvent(ctx.env, {
      event: 'email.result',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: pass.identityId,
      outcome,
      mode: pass.mode,
    });
    await recordPassEvent(ctx, {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: outcome === 'ok' ? 'email.sent' : 'email.failed',
      data: { outboxId: row.id, attached: attach, ...(code ? { code } : {}) },
    });
  };
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
    await event(
      'failed',
      error instanceof PermanentEmailError ? 'EMAIL_PERMANENT' : 'EMAIL_FAILED',
    );
    if (error instanceof PermanentEmailError) {
      ctx.log.warn('email.send_failed', { outboxId: row.id, code: 'EMAIL_PERMANENT', error });
      await finishOutbox(db, row.id, lease, 'failed', ctx.clock.now(), 'EMAIL_PERMANENT');
      return;
    }
    ctx.log.warn('email.send_failed', { outboxId: row.id, attempts: row.attempts, error });
    await retryOrGiveUp(ctx, row, lease, 'EMAIL_FAILED', 'failed');
    return;
  }
  await event('ok');
  await finishSent(ctx, row, lease, messageId);
}

/** The org's support; PassBook's own when the org has none. */
function emailSupport(
  env: object,
  settings: { 'support.email'?: string | undefined; 'support.url'?: string | undefined },
  branding: { supportEmail?: string | null; supportUrl?: string | null },
) {
  const supportEmail = settings['support.email'] ?? branding.supportEmail;
  const supportUrl = settings['support.url'] ?? branding.supportUrl;
  return supportEmail || supportUrl
    ? { supportEmail, supportUrl }
    : { supportEmail: platformSupportEmail(env), supportUrl: null };
}
