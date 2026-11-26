import type { ServiceContext } from '../../../platform/service-context.ts';
import { idpClient, idpConfigured } from '../client.ts';
import { idpCodeOf } from '../errors.ts';
import type { InviteRow } from './repo-resolve.ts';
import { pairedDeveloperOf, setupsOf } from './repo-resolve.ts';

/**
 * An invitation that ended (revoked, or accepted by someone) takes back the signup tokens nobody used yet, at once, through the binding (a used token
 * stays: the sweep finds its account). A token Polaris ID cannot withdraw now is logged and left to the sweep,
 * which runs once its last token has expired; the revoke itself never waits on Polaris ID.
 */
export async function withdrawSetups(
  ctx: ServiceContext,
  kind: InviteRow['kind'] | 'platform',
  invitationId: string,
  reason = 'invitation.revoked',
): Promise<void> {
  if (!idpConfigured(ctx.env)) return;
  const now = ctx.clock.now();
  const open = (await setupsOf(ctx.env.DB, kind, invitationId)).filter((s) => s.expires_at > now);
  if (open.length === 0) return;
  const rpc = idpClient(ctx.env, ctx.log);
  for (const setup of open) {
    try {
      await rpc.deleteSignup(setup.idp_token_id, {
        ref: invitationId,
        reason,
        actor: { kind: 'system', job: 'invitations' },
      });
    } catch (error) {
      ctx.log.warn('invitation.withdraw_failed', {
        code: idpCodeOf(error) ?? 'IDP_UNAVAILABLE',
        kind,
      });
    }
  }
}

/** A member invitation revoked on its own also ends the developer invitation it is paired with: its tokens go too. */
export async function withdrawForMember(
  ctx: ServiceContext,
  memberInvitationId: string,
): Promise<void> {
  await withdrawSetups(ctx, 'member', memberInvitationId);
  const developer = await pairedDeveloperOf(ctx.env.DB, memberInvitationId);
  if (developer) await withdrawSetups(ctx, 'developer', developer);
}
