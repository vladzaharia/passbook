import { AppError, ConflictError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { idpClient } from '../client.ts';
import { markDirty } from '../repo-dirty.ts';
import { claimsOfInvitation, insertClaim } from '../repo-invite-claims.ts';
import { ledgerOfPlatform, platformTargets } from './platform-groups.ts';
import type { PlatformInvite } from './platform-resolve.ts';
import { acceptPlatform, keyOwner, widenPlatformWindow } from './repo-platform.ts';
import { withdrawSetups } from './withdraw.ts';

const DAY = 24 * 60 * 60 * 1000;
const CLAIM_CAP = 3;

export const platformChanged = () =>
  new ConflictError('The request could not be completed.', 'INVITATION_CONFLICT');

/** Who a developer grant is by: the inviter, a key's owner, or the person accepting when neither is a user. */
async function grantedByOf(
  ctx: ServiceContext,
  invite: PlatformInvite,
  fallback: string | null,
): Promise<string | null> {
  const { created_by_user: user, created_by_key: key } = invite.row;
  if (user) return user;
  if (key) return (await keyOwner(ctx.env.DB, key)) ?? fallback;
  return fallback;
}

/**
 * Records the acceptance for a proven Polaris ID account, then takes back what nobody keeps: the invitation's unused
 * signup tokens are withdrawn, and the accounts its tokens made or that claimed it are marked dirty, so the drain
 * keeps the acceptor (a group row is the reason now) and removes the rest. `userId` is the signed-in person, for
 * developer access; null for the mailbox-only paths.
 */
export async function acceptPlatformSubject(
  ctx: ServiceContext,
  invite: PlatformInvite,
  subject: string,
  userId: string | null,
  proven: readonly string[] = [],
): Promise<void> {
  const { row } = invite;
  const grantedBy = await grantedByOf(ctx, invite, userId);
  if (invite.developer && !userId) throw platformChanged();
  const landed = await acceptPlatform(ctx, {
    id: row.id,
    subject,
    userId,
    groups: invite.groups,
    developer: invite.developer,
    grantedBy: grantedBy ?? '',
    memberIds: invite.groups.map(() => ctx.ids.id()),
    grantId: ctx.ids.id(),
    now: ctx.clock.now(),
  });
  if (!landed) throw platformChanged();
  await withdrawSetups(ctx, 'platform', row.id, 'invitation.accepted');
  const claimed = (await claimsOfInvitation(ctx.env.DB, { platform: row.id })).map(
    (c) => c.subject,
  );
  for (const who of new Set([subject, ...proven, ...claimed])) await markDirty(ctx.env.DB, who);
}

/**
 * Gives an existing Polaris ID account what the invitation carries, at once, and records why (a claim row the sweep
 * settles if nobody accepts in time). Repeating it for the same account changes nothing.
 */
export async function claimPlatformAccount(
  ctx: ServiceContext,
  invite: PlatformInvite,
  subject: string,
): Promise<void> {
  const db = ctx.env.DB;
  const { row } = invite;
  const claims = await claimsOfInvitation(db, { platform: row.id });
  const known = claims.some((c) => c.subject === subject);
  if (claims.length >= CLAIM_CAP && !known)
    throw new AppError(
      'INVITATION_CLAIM_CAPPED',
      429,
      'Too many accounts tried this invitation. Ask for a new invitation.',
    );
  if (!known) {
    const until = Math.max(row.claim_until, ctx.clock.now() + DAY);
    await widenPlatformWindow(db, row.id, until);
    await insertClaim(db, {
      id: ctx.ids.id(),
      parent: { platform: row.id },
      subject,
      now: ctx.clock.now(),
      claimUntil: until,
    });
  }
  await idpClient(ctx.env, ctx.log).apply(
    subject,
    { add: platformTargets(invite) },
    ledgerOfPlatform(invite, 'invitation.claim'),
  );
}
