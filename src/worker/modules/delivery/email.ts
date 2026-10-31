import { renderPassEmail } from '../../email/pass.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf } from '../passes/deps.ts';
import { getOrg, getPass } from '../passes/repo.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { claimOrSettle, retryOrGiveUp } from './push.ts';
import { finishOutbox } from './repo.ts';

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
  const attach = row.payload.attach === true;
  const org = await getOrg(db, pass.orgId);
  const base = baseUrl(ctx.env);
  const [platform, orgSettings] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, pass.orgId),
  ]);
  const email = renderPassEmail({
    orgName: org?.name ?? 'Wallet',
    accent: orgSettings['branding.accent'],
    downloadUrl: `${base}/p/${pass.downloadToken}/pass.pkpass`,
    manageUrl: `${base}/p/${pass.downloadToken}`,
    badgeUrl: `${base}/apple/add-to-apple-wallet.png`,
    attached: attach,
  });
  try {
    let attachments: { filename: string; type: string; content: Uint8Array }[] | undefined;
    if (attach) {
      const object = await ctx.env.BUCKET.get(pass.objectKey);
      if (!object) throw new Error('Pass object is missing.');
      attachments = [
        {
          filename: 'pass.pkpass',
          type: 'application/vnd.apple.pkpass',
          content: new Uint8Array(await object.arrayBuffer()),
        },
      ];
    }
    const { messageId } = await depsOf(ctx.env).mailer.send({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: platform['email.senderName'],
      ...(attachments ? { attachments } : {}),
    });
    await finishOutbox(db, row.id, lease, 'sent', ctx.clock.now(), null, messageId);
  } catch (error) {
    ctx.log.warn('email.send_failed', { outboxId: row.id, attempts: row.attempts, error });
    await retryOrGiveUp(ctx, row, lease, 'EMAIL_FAILED', 'failed');
  }
}
