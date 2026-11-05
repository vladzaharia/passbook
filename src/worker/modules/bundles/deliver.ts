import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderBundleEmail } from '../../email/bundle.ts';
import { passEmailImages } from '../../email/pass-images.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { finishSent } from '../delivery/email-finish.ts';
import { failEmail, recordEmailOutcome } from '../delivery/email-outcome.ts';
import { finishOutbox, type OutboxRow } from '../delivery/repo.ts';
import { depsOf } from '../passes/deps.ts';
import { getOrg, getPass } from '../passes/repo.ts';
import { passImages, supportContacts } from '../public/service.ts';
import { captureEmail } from '../sandbox/capture.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { bundleImages } from './assets.ts';
import { getBundle, membersOf } from './repo.ts';

/**
 * Sends a claimed outbox row whose payload names a bundle (`deliverEmail` hands it over once the
 * org and the recipient are checked). A test bundle never sends: its message is captured (modules/sandbox).
 */
export async function deliverBundleEmail(
  ctx: ServiceContext,
  claimed: { row: OutboxRow; lease: string; to: string },
): Promise<void> {
  const { row, lease, to } = claimed;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const bundleId = String(row.payload.bundleId);
  const bundle = await getBundle(db, bundleId, null);
  const members = bundle ? await membersOf(db, [bundleId]) : [];
  const first = members[0] ? await getPass(db, members[0].pass_id) : null;
  if (!bundle || !first) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'BUNDLE_GONE');
    return;
  }
  if (row.providerId) {
    await finishOutbox(db, row.id, lease, 'sent', now, null, row.providerId);
    return;
  }
  const base = baseUrl(ctx.env);
  const page = `${base}/b/${bundle.token}`;
  const [org, platform, settings, support, images] = await Promise.all([
    getOrg(db, bundle.org_id),
    getPlatformSettings(ctx),
    getOrgSettings(ctx, bundle.org_id),
    supportContacts(ctx, bundle.org_id),
    passImages(ctx, first).catch((error: unknown) => {
      ctx.log.warn('email.images_failed', { outboxId: row.id, code: 'EMAIL_IMAGES', error });
      return [];
    }),
  ]);
  const { iconUrl } = passEmailImages(
    bundleImages(images, first.downloadToken, bundle.token, first.id),
    base,
  );
  const email = renderBundleEmail({
    orgName: org?.name ?? 'PassBook',
    bundleName: bundle.name,
    supportEmail: support.email,
    supportUrl: support.url,
    pageUrl: page,
    addAllUrl: `${page}/passes.pkpasses`,
    badgeUrl: emailAssetUrl(base, EMAIL_BADGE.path),
    passes: members.map((m) => ({
      title: m.title,
      addUrl: m.status === 'active' ? `${page}/${m.pass_id}/pass.pkpass` : null,
    })),
    iconUrl,
    senderName: platform['email.senderName'],
    mode: bundle.mode,
    buddyBase: settings['email.buddy'] ? base : null,
  });
  if (bundle.mode === 'test') {
    await captureEmail(ctx, {
      row,
      lease,
      orgId: bundle.org_id,
      eventPassId: first.id,
      bundleId,
      to,
      email,
    });
    return;
  }
  const target = {
    orgId: bundle.org_id,
    passId: first.id,
    mode: bundle.mode,
    templateId: null,
    identityId: null,
    bundleId,
  };
  let messageId: string;
  try {
    ({ messageId } = await depsOf(ctx.env).mailer.send({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: email.fromName ?? platform['email.senderName'],
    }));
  } catch (error) {
    await failEmail(ctx, claimed, target, error);
    return;
  }
  await recordEmailOutcome(ctx, row, target, 'ok');
  await finishSent(ctx, row, lease, messageId);
}
