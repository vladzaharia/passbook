import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './repo-magic.ts';

/** What an invitation-bound sign-in link offers: the page names it before the click. */
export interface LinkInvitation {
  orgName: string;
  roles: string[];
}

export interface PeekedLink {
  email: string;
  purpose: repo.MagicPurpose;
  /** verify_email: the account that asked, and its primary email. */
  userId: string | null;
  requester: string | null;
  /** A plain sign-in link: refused while email sign-in is off. */
  needsEmailSignIn: boolean;
  next: string | null;
  invitation: LinkInvitation | null;
}

const parseRoles = (raw: string): string[] => {
  try {
    const roles: unknown = JSON.parse(raw);
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
};

async function invitationOf(
  ctx: ServiceContext,
  id: string | null,
): Promise<LinkInvitation | null> {
  if (!id) return null;
  const row = await repo.invitationOffer(ctx.env.DB, id);
  return row ? { orgName: row.name, roles: parseRoles(row.roles) } : null;
}

export async function peekMagicLink(
  ctx: ServiceContext,
  token: string,
): Promise<PeekedLink | null> {
  const link = await repo.peekLink(ctx.env.DB, await sha256Hex(token), ctx.clock.now());
  if (!link) return null;
  const requester =
    link.purpose === 'verify_email' && link.user_id
      ? await repo.primaryEmailOf(ctx.env.DB, link.user_id)
      : null;
  return {
    email: link.email,
    purpose: link.purpose,
    userId: link.user_id,
    requester,
    needsEmailSignIn: link.purpose === 'sign_in' && !link.pending_identity,
    next: link.redirect_path,
    invitation: await invitationOf(ctx, link.invitation_id),
  };
}

/** An invitation behind a link: pending is still open (the address has an account, so it signs in). */
export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface LinkTrace {
  next: string | null;
  purpose: repo.MagicPurpose;
  /** Already clicked, or no longer live (expired, or its invitation is gone). */
  state: 'used' | 'expired';
  /** Set for an invitation link: a fresh sign-in would not join the org. */
  invited: boolean;
  invitation: InvitationState | null;
  /** The link carries a Pocket ID subject to link: a plain sign-in mail would not do it. */
  identity: boolean;
  /** The address the link was for. Pages show it masked; it is never logged. */
  email: string;
}

/** What a link, live or not, was for and where it meant to return: its dead-link page says so. */
export async function magicLinkTrace(
  ctx: ServiceContext,
  token: string,
): Promise<LinkTrace | null> {
  if (token.length < 16 || token.length > 256) return null;
  const row = await repo.linkTrace(ctx.env.DB, await sha256Hex(token));
  if (!row) return null;
  let invitation: InvitationState | null = null;
  if (row.invitation_id !== null) {
    if (row.inv_accepted_at !== null) invitation = 'accepted';
    else if (row.inv_revoked_at !== null || row.org_status !== 'active') invitation = 'revoked';
    else if ((row.inv_expires_at ?? 0) <= ctx.clock.now()) invitation = 'expired';
    else invitation = row.has_account ? 'pending' : 'expired';
  }
  return {
    next: row.redirect_path,
    purpose: row.purpose,
    state: row.consumed_at === null ? 'expired' : 'used',
    invited: row.invitation_id !== null,
    invitation,
    identity: row.has_identity === 1,
    email: row.email,
  };
}
