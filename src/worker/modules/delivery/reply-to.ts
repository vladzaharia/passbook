import { strictEmail } from '../../../shared/email.ts';
import { renderReplyToConfirm } from '../../email/reply-to-confirm.ts';
import { baseUrl } from '../../platform/env.ts';
import { BadRequestError, ConflictError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { depsOf } from '../passes/deps.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { isPlatformAddress } from '../settings/reply-to-domain.ts';
import { getOrgSettings } from '../settings/service.ts';
import { bumpCounter, readCounter } from './repo-email-queue.ts';
import {
  confirmReplyToRow,
  deleteReplyTo,
  getReplyTo,
  putPendingReplyTo,
} from './repo-reply-to.ts';

const LINK_TTL_MS = 24 * 3_600_000;
/** Between two links for one org, and links per org per day. */
const RESEND_GAP_MS = 60_000;
const DAILY_LINKS = 5;
const DAY = 86_400_000;

export type ReplyToState = 'none' | 'pending' | 'confirmed';

async function sendLink(
  ctx: ServiceContext,
  orgId: string,
  address: string,
  send = true,
): Promise<void> {
  const now = ctx.clock.now();
  const token = ctx.ids.token(32);
  await putPendingReplyTo(
    ctx.env.DB,
    orgId,
    address,
    await sha256Hex(token),
    now + LINK_TTL_MS,
    now,
  );
  if (!send) return;
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  const org = await getOrg(ctx.env.DB, orgId);
  const email = renderReplyToConfirm({
    orgName: org?.name ?? 'An organization',
    address,
    link: `${baseUrl(ctx.env)}/admin/o/${encodeURIComponent(orgId)}/settings?confirmReplyTo=${token}`,
  });
  try {
    await depsOf(ctx.env).mailer.send({ to: address, ...email, fromName: 'PassBook' });
  } catch (error) {
    // The address stays pending; Resend tries again.
    ctx.log.warn('reply_to.confirm_send_failed', {
      orgId,
      code: 'REPLY_TO_CONFIRM_SEND',
      reason: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Called after the org's support address changed: a new one waits for confirmation. */
export async function syncReplyTo(
  ctx: ServiceContext,
  orgId: string,
  address: string | null | undefined,
): Promise<void> {
  const next = strictEmail(address);
  if (!next || isPlatformAddress(ctx.env, next)) {
    await deleteReplyTo(ctx.env.DB, orgId);
    return;
  }
  const row = await getReplyTo(ctx.env.DB, orgId);
  if (row?.address === next) return;
  // A new address is mailed a link, at most DAILY_LINKS times a day for the org: past that it waits, and Resend
  // sends later. A key that changes the address in a loop cannot make PassBook mail strangers.
  const now = ctx.clock.now();
  const window = now - (now % DAY);
  const key = `reply-to-confirm:${orgId}`;
  if ((await readCounter(ctx.env.DB, key, window)) >= DAILY_LINKS) {
    ctx.log.warn('reply_to.confirm_capped', { orgId, code: 'REPLY_TO_CONFIRM_CAPPED' });
    await sendLink(ctx, orgId, next, false);
    return;
  }
  await bumpCounter(ctx.env.DB, key, window);
  await sendLink(ctx, orgId, next);
}

export async function replyToStatus(ctx: ServiceContext, orgId: string) {
  const address = strictEmail((await getOrgSettings(ctx, orgId))['support.email']);
  if (!address) return { address: null, state: 'none' as ReplyToState };
  const row = await getReplyTo(ctx.env.DB, orgId);
  const confirmed = row?.address === address && row.confirmed_at !== null;
  return { address, state: (confirmed ? 'confirmed' : 'pending') as ReplyToState };
}

export async function resendReplyTo(ctx: ServiceContext, orgId: string): Promise<void> {
  const { address, state } = await replyToStatus(ctx, orgId);
  if (!address || state === 'confirmed' || isPlatformAddress(ctx.env, address))
    throw new ConflictError('There is nothing to confirm.', 'REPLY_TO_NOTHING_PENDING');
  const now = ctx.clock.now();
  const row = await getReplyTo(ctx.env.DB, orgId);
  const window = now - (now % DAY);
  const key = `reply-to-confirm:${orgId}`;
  if (
    (row?.sent_at != null && now - row.sent_at < RESEND_GAP_MS) ||
    (await readCounter(ctx.env.DB, key, window)) >= DAILY_LINKS
  )
    throw new ConflictError('Wait a minute, then send the link again.', 'REPLY_TO_RESEND_LIMITED');
  await bumpCounter(ctx.env.DB, key, window);
  await sendLink(ctx, orgId, address);
}

export async function confirmReplyTo(ctx: ServiceContext, orgId: string, token: string) {
  const { address } = await replyToStatus(ctx, orgId);
  const ok =
    address !== null &&
    (await confirmReplyToRow(ctx.env.DB, orgId, address, await sha256Hex(token), ctx.clock.now()));
  if (!ok) throw new BadRequestError('This link is invalid or expired.', 'REPLY_TO_LINK_INVALID');
}

/** The reply-to for an org's mail: its support address, once confirmed and not a platform address. */
export async function replyToFor(
  ctx: ServiceContext,
  orgId: string,
  address: string | null | undefined,
): Promise<string | undefined> {
  const email = strictEmail(address);
  if (!email || isPlatformAddress(ctx.env, email)) return undefined;
  const row = await getReplyTo(ctx.env.DB, orgId);
  return row?.address === email && row.confirmed_at !== null ? email : undefined;
}
