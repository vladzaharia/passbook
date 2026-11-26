import type { SignupSpec, Target, WriteCtx } from '../types.ts';
import type { PlatformInvite } from './platform-resolve.ts';

/** Who a binding write is for, in the ledger: the invitation, and the service as the actor (no session exists yet). */
export const ledgerOfPlatform = (invite: PlatformInvite, reason: string): WriteCtx => ({
  ref: invite.row.id,
  reason,
  actor: { kind: 'system', job: 'invitations' },
});

/** A developer invitation's token carries developer; the groups come from the row alone. */
export const platformSignupSpec = (invite: PlatformInvite): SignupSpec => ({
  kind: invite.developer ? 'developer' : 'platform',
  ...(invite.groups.length ? { groups: invite.groups } : {}),
});

/** What an existing account is given at once when it claims the invitation. */
export const platformTargets = (invite: PlatformInvite): Target[] => [
  ...(invite.developer ? (['developer'] as const) : []),
  ...invite.groups.map((key): Target => `g:${key}`),
];
