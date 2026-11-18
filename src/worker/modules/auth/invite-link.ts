import { baseUrl } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withinDailyCap } from './magic-caps.ts';
import { isEmailSignInEnabled } from './magic-service.ts';
import * as repo from './repo-magic.ts';

/**
 * A sign-in link for an invitee with no account, carried inside the invitation mail instead of a
 * second one. It is bound to its invitation: it works only while that is pending, and signing in
 * through it joins the org, so no invitation secret is stored with it. It lands on the account page.
 *
 * The row is written whether or not the link is wanted (`usable` false: the address already has an
 * account), so the inviter cannot tell the two apart by timing. An unusable row is born expired.
 */
export async function createInviteSignInLink(
  ctx: ServiceContext,
  input: { email: string; invitationId: string; ttlMs: number; usable: boolean },
): Promise<string | null> {
  const enabled = await isEmailSignInEnabled(ctx);
  const capped = !(await withinDailyCap(ctx));
  if (capped) ctx.log.error('auth.magic_daily_cap', { code: 'MAGIC_DAILY_CAP' });
  const wanted = input.usable && enabled && !capped;
  const now = ctx.clock.now();
  const token = ctx.ids.token(32);
  await repo.insertLink(ctx.env.DB, {
    tokenHash: await sha256Hex(token),
    email: input.email,
    purpose: 'sign_in',
    userId: null,
    codeHash: null,
    bindingHash: null,
    redirectPath: '/account',
    pendingIdentity: null,
    invitationId: input.invitationId,
    now,
    expiresAt: wanted ? now + input.ttlMs : now,
  });
  return wanted ? `${baseUrl(ctx.env)}/auth/magic?t=${token}` : null;
}
