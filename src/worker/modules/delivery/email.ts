import { renderEmailSubject } from '../../../passkit/template/email.ts';
import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailBrandOf } from '../../email/brand.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import { passEmailImages } from '../../email/pass-images.ts';
import { passSummary } from '../../email/pass-summary.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { deliverBundleEmail } from '../bundles/deliver.ts';
import { holderChannels, recordCopy } from '../channels/gate.ts';
import { assertSignedObject, isPreviewOnlyOrg, testPreviewUrl } from '../developer/fence.ts';
import { isJoinCard } from '../join/repo-issues.ts';
import { isOrgActive } from '../orgs/active.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { currentPassBytes } from '../passes/timed-variant.ts';
import { passImages } from '../public/service.ts';
import { captureEmail } from '../sandbox/capture.ts';
import { loadManifests, manifestCacheKey } from '../scan/repo-template-manifests.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { matchesPass, PassEmailIntentSchema } from './binding.ts';
import { finishSent } from './email-finish.ts';
import { orgFromName, passEmailOrgName } from './email-from.ts';
import {
  failEmail,
  PermanentEmailError,
  recordEmailOutcome,
  uncertainEmail,
} from './email-outcome.ts';
import { holderNoticeCopy } from './notice-copy.ts';
import { claimOrSettle } from './push.ts';
import { replyToFor } from './reply-to.ts';
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
  const channels = await holderChannels(ctx, pass);
  const manifests = new Map<string, string | null>();
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
    listWalletOffers(ctx, pass.id, channels.effective).catch((error: unknown) => {
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
  let plainToken: string;
  try {
    plainToken = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
  } catch (error) {
    // The link changed since the pass was read, or its copy is unreadable (logged): nothing goes out.
    if (!(error instanceof AppError) || !error.code.startsWith('TOKEN_SEAL_')) throw error;
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'DELIVERY_STALE');
    return;
  }
  const attachApple = attach && channels.effective.apple.on;
  const { iconUrl, logo } = passEmailImages(images, base);
  const support = emailSupport(ctx.env, orgSettings, branding);
  const fromName = orgFromName(ctx, orgSettings['email.fromName'], platform['email.senderName']);
  const replyTo = await replyToFor(ctx, pass.orgId, orgSettings['support.email']);
  const orgName = passEmailOrgName(org);
  const templateKey = {
    orgId: pass.orgId,
    templateId: pass.templateId,
    version: pass.templateVersion,
  };
  await loadManifests(db, manifests, [templateKey]);
  const manifestJson = manifests.get(manifestCacheKey(templateKey));
  const email = renderPassEmail({
    orgName,
    ...support,
    subject: renderEmailSubject(
      manifestJson ? JSON.parse(manifestJson) : null,
      pass.personalization,
      `Your ${orgName} pass`,
    ),
    fromName,
    downloadUrl: channels.effective.apple.on ? `${base}/p/${plainToken}/pass.pkpass` : null,
    printUrl: channels.holderPrint ? `${base}/p/${plainToken}/print` : null,
    // A developer org's holder has no wallet to add the pass to: the link is its TEST preview page.
    manageUrl: (await isPreviewOnlyOrg(db, pass.orgId))
      ? await testPreviewUrl(ctx.env, base, pass, ctx.clock.now())
      : `${base}/p/${plainToken}`,
    badgeUrl: emailAssetUrl(base, EMAIL_BADGE.path),
    publicBaseUrl: base,
    walletOffers,
    attached: attachApple,
    passTitle:
      pass.displayTitle ?? (typeof passJson.description === 'string' ? passJson.description : null),
    summary: passSummary(passJson, { now: new Date(now) }),
    iconUrl,
    logo,
    logoText:
      branding.logoHasName || typeof passJson.logoText !== 'string' ? null : passJson.logoText,
    senderName: platform['email.senderName'],
    mode: pass.mode,
    joined: intent.joined === true || (await isJoinCard(db, pass.id)),
    ...(intent.notice ? { notice: holderNoticeCopy(intent.notice) } : {}),
    buddyBase: orgSettings['email.buddy'] ? base : null,
    brand: emailBrandOf(ctx.env, await orgBrandOf(ctx, pass.orgId)),
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
      attached: attachApple,
    });
    return;
  }
  const target = {
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    templateId: pass.templateId,
    identityId: pass.identityId,
    attached: attachApple,
  };
  let attachments: { filename: string; type: string; content: Uint8Array }[] | undefined;
  try {
    if (attachApple) {
      assertSignedObject(pass.objectKey);
      // The pass as its last event boundary left it (docs/design/event-boundaries.md).
      const content = await currentPassBytes(ctx, pass);
      if (!content) throw new PermanentEmailError('Pass object is missing.');
      attachments = [{ filename: 'pass.pkpass', type: 'application/vnd.apple.pkpass', content }];
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
  // Developer mail is captured above; reaching the mailer is a bug, and the row ends instead of retrying.
  if (await isPreviewOnlyOrg(db, pass.orgId)) {
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'SANDBOX_PREVIEW_ONLY');
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
      ...(replyTo ? { replyTo } : {}),
      ...(attachments ? { attachments } : {}),
    }));
  } catch {
    await uncertainEmail(ctx, claimed, target);
    return;
  }
  await finishSent(ctx, row, lease, messageId);
  if (attachApple) await recordCopy(ctx, pass, 'apple');
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
