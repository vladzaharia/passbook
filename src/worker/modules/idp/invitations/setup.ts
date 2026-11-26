import type { z } from 'zod';
import type {
  InvitationChallengeSchema,
  InvitationSetup,
} from '../../../../shared/contracts/invitations.ts';
import { AppError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { idpClient } from '../client.ts';
import { challengedInvite, ledgerOf } from './challenge.ts';
import { signupSpecOf } from './groups.ts';
import { setupsOf } from './repo-resolve.ts';
import { insertSetup } from './repo-writes.ts';

const DAY = 24 * 60 * 60 * 1000;
/** Setup links one invitation may mint (the trigger holds the same line). */
export const SETUP_CAP = 3;

/**
 * "Create a Polaris ID": mints a one-hour, one-use signup token that carries the invitation's groups, at the
 * person's click. The link goes to the page and nowhere else; only the token's id is kept. A fourth link is refused;
 * a new one withdraws the previous one if nobody used it yet.
 */
export async function setupInvitation(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<InvitationSetup> {
  const invite = await challengedInvite(ctx, ip, input);
  const db = ctx.env.DB;
  const { row, kind } = invite;
  const earlier = await setupsOf(db, kind, row.id);
  if (earlier.length >= SETUP_CAP)
    throw new AppError(
      'INVITATION_SETUP_CAPPED',
      429,
      'Too many links for this invitation. Ask for a new invitation.',
    );
  const rpc = idpClient(ctx.env, ctx.log);
  const write = ledgerOf(invite, 'invitation.setup');
  const signup = await rpc.createSignup(await signupSpecOf(db, invite), write);
  if ('dryRun' in signup)
    throw new AppError(
      'IDP_UNAVAILABLE',
      503,
      'Polaris ID is not reachable. Try again in a few minutes.',
    );
  const now = ctx.clock.now();
  try {
    await insertSetup(
      ctx,
      {
        kind,
        invitationId: row.id,
        tokenId: signup.tokenId,
        now,
        expires: signup.expiresAt,
        claimUntil: now + DAY,
      },
      {
        orgId: row.org_id,
        actorType: 'system',
        action: `${kind === 'member' ? 'org' : 'developer'}_invitation.setup`,
        targetType: `${kind === 'member' ? 'org' : 'developer'}_invitation`,
        targetId: row.id,
        detail: { n: earlier.length + 1 },
      },
    );
  } catch (error) {
    // The token exists in Polaris ID but nothing here points at it: withdraw it.
    await rpc.deleteSignup(signup.tokenId, write).catch(() => undefined);
    throw error;
  }
  // Every older live token is withdrawn, read again now, so setups racing leave the newest one (by time, then id).
  for (const other of await setupsOf(db, kind, row.id)) {
    const older =
      other.created_at < now || (other.created_at === now && other.idp_token_id < signup.tokenId);
    if (older && other.expires_at > now)
      await rpc.deleteSignup(other.idp_token_id, write).catch(() => {
        ctx.log.warn('invitation.setup_unwithdrawn', { code: 'INVITATION_SETUP_UNWITHDRAWN' });
      });
  }
  return { setupUrl: signup.url, expiresAt: signup.expiresAt };
}
