import { baseUrl } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isEmailSignInEnabled } from './magic-service.ts';
import * as repo from './repo-magic.ts';

/**
 * A sign-in link for an invitee with no account, carried inside the invitation mail instead of a
 * second one. Any browser may use it, like a link that was mailed; the invitation is accepted at `next`.
 */
export async function createInviteSignInLink(
  ctx: ServiceContext,
  input: { email: string; next: string; ttlMs: number },
): Promise<string | null> {
  if (!(await isEmailSignInEnabled(ctx))) return null;
  const now = ctx.clock.now();
  const token = ctx.ids.token(32);
  await repo.insertLink(ctx.env.DB, {
    tokenHash: await sha256Hex(token),
    email: input.email,
    purpose: 'sign_in',
    userId: null,
    codeHash: null,
    bindingHash: null,
    redirectPath: input.next,
    pendingIdentity: null,
    now,
    expiresAt: now + input.ttlMs,
  });
  return `${baseUrl(ctx.env)}/auth/magic?t=${token}`;
}
