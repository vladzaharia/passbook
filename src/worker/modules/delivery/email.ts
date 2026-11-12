import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import { passEmailImages } from '../../email/pass-images.ts';
import { passSummary } from '../../email/pass-summary.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { deliverBundleEmail } from '../bundles/deliver.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { passImages } from '../public/service.ts';
import { captureEmail } from '../sandbox/capture.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { matchesPass, PassEmailIntentSchema } from './binding.ts';
import { finishSent } from './email-finish.ts';
import {
  failEmail,
  PermanentEmailError,
  recordEmailOutcome,
  uncertainEmail,
} from './email-outcome.ts';
import { claimOrSettle } from './push.ts';
import { orgBranding } from './repo.ts';
import { hasDeliveryLease, passJsonForArtifact } from './repo-binding.ts';
import { passEmailOutput } from './repo-issuance-intent-fence.ts';
import { finishOutbox } from './repo-outbox-processing.ts';
import { ATTEMPT_CANCEL_CODE, beginProviderAttempt } from './repo-provider-attempt.ts';

export async function deliverEmail(ctx: ServiceContext, outboxId: string): Promise<void> {
  const db = ctx.env.DB;
  const claimed = await claimOrSettle(ctx, outboxId);
  if (!claimed) return;
  const { row, lease } = claimed;
  const now = ctx.clock.now();
  if (row.providerId) {
    // A provider acceptance remains an outcome even if the pass has since changed.
    await finishOutbox(db, row.id, lease, 'sent', now, null, row.providerId);
    return;
  }
  if (typeof row.payload.bundleId === 'string') {
    // Bundle delivery checks the complete member and credential snapshot.
    const bundleTo = typeof row.payload.to === 'string' ? row.payload.to : null;
    if (!bundleTo) await finishOutbox(db, row.id, lease, 'cancelled', now, 'NO_RECIPIENT');
    else if (!(await isOrgActive(ctx, row.orgId)))
      await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    else await deliverBundleEmail(ctx, { row, lease, to: bundleTo });
    return;
  }
  const parsed = PassEmailIntentSchema.safeParse(row.payload.intent);
  if (
    !parsed.success ||
    row.payload.to !== parsed.data.to ||
    row.payload.attach !== parsed.data.attach ||
    row.passId !== parsed.data.pass.passId ||
    row.orgId !== parsed.data.pass.orgId
  ) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'DELIVERY_UNBOUND');
    return;
  }
  const intent = parsed.data;
  const pass = await getPass(db, intent.pass.passId);
  if (!pass || !matchesPass(pass, intent.pass)) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'DELIVERY_STALE');
    return;
  }
  if (!(await isOrgActive(ctx, pass.orgId))) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    return;
  }
  const { to, attach } = intent;
  const stillCurrent = async () => {
    const [current, leased, active] = await Promise.all([
      getPass(db, intent.pass.passId),
      hasDeliveryLease(db, row.id, lease, ctx.clock.now()),
      isOrgActive(ctx, row.orgId),
    ]);
    if (!leased) return false;
    if (!active) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'ORG_INACTIVE');
      return false;
    }
    if (!current || !matchesPass(current, intent.pass)) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'DELIVERY_STALE');
      return false;
    }
    return true;
  };
  const org = await getOrg(db, pass.orgId);
  const base = baseUrl(ctx.env);
  const [platform, orgSettings, branding, artifact, images, walletOffers] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, pass.orgId),
    orgBranding(db, pass.orgId),
    passJsonForArtifact(db, pass.id, pass.objectKey, pass.version),
    // Without them the email still goes, with the org's name and no pass art.
    passImages(ctx, pass).catch((error: unknown) => {
      ctx.log.warn('email.images_failed', { outboxId: row.id, code: 'EMAIL_IMAGES', error });
      return [];
    }),
    // Provider errors may contain credentials: log a stable code and the error class, not the cause.
    listWalletOffers(ctx, pass.id).catch((error: unknown) => {
      ctx.log.warn('email.wallet_offers_failed', {
        outboxId: row.id,
        code: 'WALLET_OFFERS_FAILED',
        reason: error instanceof Error ? error.name : typeof error,
      });
      throw new Error('Wallet offer lookup failed.');
    }),
  ]);
  if (!artifact) {
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'DELIVERY_ARTIFACT_GONE');
    return;
  }
  const passJson = parseStoredPassJson(artifact.pass_json);
  const { iconUrl, logo } = passEmailImages(images, base);
  const email = renderPassEmail({
    orgName: org?.name ?? 'PassBook',
    ...emailSupport(ctx.env, orgSettings, branding),
    downloadUrl: `${base}/p/${pass.downloadToken}/pass.pkpass`,
    manageUrl: `${base}/p/${pass.downloadToken}`,
    badgeUrl: emailAssetUrl(base, EMAIL_BADGE.path),
    publicBaseUrl: base,
    walletOffers,
    attached: attach,
    passTitle:
      pass.displayTitle ?? (typeof passJson.description === 'string' ? passJson.description : null),
    summary: passSummary(passJson, { now: new Date(now) }),
    iconUrl,
    logo,
    logoText:
      branding.logoHasName || typeof passJson.logoText !== 'string' ? null : passJson.logoText,
    senderName: platform['email.senderName'],
    mode: pass.mode,
    buddyBase: orgSettings['email.buddy'] ? base : null,
  });
  if (pass.mode === 'test') {
    if (!(await stillCurrent())) return;
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
  const target = {
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    templateId: pass.templateId,
    identityId: pass.identityId,
    attached: attach,
  };
  let attachments: { filename: string; type: string; content: Uint8Array }[] | undefined;
  try {
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
    if (!(await stillCurrent())) return;
  } catch (error) {
    await failEmail(ctx, claimed, target, error);
    return;
  }
  // If this D1 write has an ambiguous result, leave the lease for the sweeper. It will not
  // retry a committed provider marker.
  const output = await passEmailOutput(db, row.id, intent, intent.pass);
  if (output?.legacy)
    ctx.log.info('delivery.legacy_intent', { code: 'DELIVERY_LEGACY_INTENT', outboxId: row.id });
  const attempt = output
    ? await beginProviderAttempt(ctx, {
        id: row.id,
        lease,
        orgId: pass.orgId,
        mode: pass.mode,
        passId: pass.id,
        output,
        now: ctx.clock.now(),
      })
    : 'stale';
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
      ...(attachments ? { attachments } : {}),
    }));
  } catch {
    await uncertainEmail(ctx, claimed, target);
    return;
  }
  await finishSent(ctx, row, lease, messageId);
  await recordEmailOutcome(ctx, row, target, 'ok');
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
