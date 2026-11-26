import { z } from 'zod';
import { INVITE_SECRET } from '../invitation-link.ts';
import { TimestampSchema } from './common.ts';
import { OrgMembershipSchema, OrgRoleSchema } from './org-membership.ts';

/** The one invitation page's family: member, developer and platform invitations. The secret is the credential. */
export const InvitationSecretSchema = z.string().regex(INVITE_SECRET);

export const InvitationTokenSchema = z.strictObject({ token: InvitationSecretSchema });

/** Making a Polaris ID, or finding the one that has the invited address, answers a Turnstile check first. */
export const InvitationChallengeSchema = z.strictObject({
  token: InvitationSecretSchema,
  turnstileToken: z.string().min(1).max(4096),
});

export const InvitationPreviewSchema = z.object({
  kind: z.enum(['member', 'developer', 'platform']),
  /** The org the person joins; null for a platform invitation. */
  orgName: z.string().nullable(),
  /** Platform invitations: the groups the person gets, by display name. */
  groups: z.array(z.string()),
  /** The org roles the person joins with; empty for developer access alone. */
  roles: z.array(OrgRoleSchema),
  developer: z.boolean(),
  /** The invited address with all but its first letter hidden. */
  email: z.string(),
  expiresAt: TimestampSchema,
  /** Polaris ID can make or find the account now. False while it is unreachable or in dry run. */
  polaris: z.boolean(),
});
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

export const InvitationSetupSchema = z.object({
  /** A one-hour, one-use link to Polaris ID's signup. A bearer link: show it once, never store it. */
  setupUrl: z.string(),
  expiresAt: TimestampSchema,
});
export type InvitationSetup = z.infer<typeof InvitationSetupSchema>;

export const InvitationClaimSchema = z.object({ ok: z.literal(true) });

export const InvitationAcceptSchema = z.object({
  /** `refresh`: the person gained a Polaris ID group; one more sign-in picks it up. */
  outcome: z.enum(['joined', 'refresh']),
  kind: z.enum(['member', 'developer', 'platform']),
  orgName: z.string().nullable(),
  membership: OrgMembershipSchema.nullable(),
});
export type InvitationAccept = z.infer<typeof InvitationAcceptSchema>;

/** What `confirm` answers once the person has finished creating their Polaris ID and the invited address matched. */
export const InvitationConfirmSchema = z.object({ outcome: z.literal('joined') });
export type InvitationConfirm = z.infer<typeof InvitationConfirmSchema>;
