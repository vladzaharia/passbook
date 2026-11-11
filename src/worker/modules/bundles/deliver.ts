import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderBundleEmail } from '../../email/bundle.ts';
import { passEmailImages } from '../../email/pass-images.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { finishSent } from '../delivery/email-finish.ts';
import { recordEmailOutcome, uncertainEmail } from '../delivery/email-outcome.ts';
import { hasDeliveryLease } from '../delivery/repo-binding.ts';
import type { OutboxRow } from '../delivery/repo-outbox-map.ts';
import { finishOutbox } from '../delivery/repo-outbox-processing.ts';
import { ATTEMPT_CANCEL_CODE, beginProviderAttempt } from '../delivery/repo-provider-attempt.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { passImages, supportContacts } from '../public/service.ts';
import { captureEmail } from '../sandbox/capture.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { bundleImages } from './assets.ts';
import { BundleEmailIntentSchema, bundleEmailSnapshot, matchesBundle } from './email-binding.ts';
import { bundleChecks } from './repo-delivery-fence.ts';

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
  if (row.providerId) {
    await finishOutbox(db, row.id, lease, 'sent', now, null, row.providerId);
    return;
  }
  const parsed = BundleEmailIntentSchema.safeParse(row.payload.intent);
  if (
    !parsed.success ||
    row.payload.bundleId !== parsed.data.bundleId ||
    row.payload.to !== parsed.data.to ||
    to !== parsed.data.to ||
    row.orgId !== parsed.data.orgId ||
    row.passId !== parsed.data.members[0]?.passId
  ) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'DELIVERY_UNBOUND');
    return;
  }
  const intent = parsed.data;
  const snapshot = await bundleEmailSnapshot(db, intent.bundleId);
  const first = snapshot?.passes[0];
  if (!snapshot || !first || !(await matchesBundle(snapshot, intent))) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'DELIVERY_STALE');
    return;
  }
  const { bundle, passes } = snapshot;
  const bundleId = bundle.id;
  const stillCurrent = async () => {
    const [current, leased, active] = await Promise.all([
      bundleEmailSnapshot(db, bundleId),
      hasDeliveryLease(db, row.id, lease, ctx.clock.now()),
      isOrgActive(ctx, row.orgId),
    ]);
    if (!leased) return false;
    if (!active) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'ORG_INACTIVE');
      return false;
    }
    if (!current || !(await matchesBundle(current, intent))) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'DELIVERY_STALE');
      return false;
    }
    return true;
  };
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
    passes: passes.map((pass) => ({
      title: pass.displayTitle ?? pass.serial,
      addUrl:
        pass.status === 'active' && pass.removedAt === null
          ? `${page}/${pass.id}/pass.pkpass`
          : null,
    })),
    iconUrl,
    senderName: platform['email.senderName'],
    mode: bundle.mode,
    buddyBase: settings['email.buddy'] ? base : null,
  });
  if (bundle.mode === 'test') {
    if (!(await stillCurrent())) return;
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
  if (!(await stillCurrent())) return;
  if (!intent.actor)
    ctx.log.info('delivery.legacy_intent', { code: 'DELIVERY_LEGACY_INTENT', outboxId: row.id });
  const attempt = await beginProviderAttempt(ctx, {
    id: row.id,
    lease,
    orgId: bundle.org_id,
    mode: bundle.mode,
    passId: first.id,
    output: {
      actor: intent.actor ?? { kind: 'system' },
      checks: [rowIs('passes', first.id, { deleted_at: null }), ...bundleChecks(snapshot)],
    },
    now: ctx.clock.now(),
  });
  if (attempt !== 'started') {
    await finishOutbox(
      db,
      row.id,
      lease,
      'cancelled',
      ctx.clock.now(),
      ATTEMPT_CANCEL_CODE[attempt],
    );
    return;
  }
  let messageId: string;
  try {
    ({ messageId } = await depsOf(ctx.env).mailer.send({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: email.fromName ?? platform['email.senderName'],
    }));
  } catch {
    await uncertainEmail(ctx, claimed, target);
    return;
  }
  await finishSent(ctx, row, lease, messageId);
  await recordEmailOutcome(ctx, row, target, 'ok');
}
