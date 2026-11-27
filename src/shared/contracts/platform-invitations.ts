import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import { GroupKeyParamSchema } from './idp-access.ts';
import { InvitationEmailSchema } from './org-membership.ts';

/** Polaris ID groups a platform invitation may carry: custom or adopted, at most five. */
export const PLATFORM_INVITATION_MAX_GROUPS = 5;

export const CreatePlatformInvitationSchema = z
  .strictObject({
    email: InvitationEmailSchema,
    /** Group keys (custom or adopted); empty only with `developer`. */
    groups: z
      .array(GroupKeyParamSchema.shape.key)
      .max(PLATFORM_INVITATION_MAX_GROUPS)
      .refine((keys) => new Set(keys).size === keys.length, 'Each group once.')
      .default([]),
    /** Also grants platform developer access, which needs a PassBook sign-in to accept. */
    developer: z.boolean().default(false),
  })
  .refine((v) => v.developer || v.groups.length > 0, 'Choose a group or developer access.');
export type CreatePlatformInvitation = z.infer<typeof CreatePlatformInvitationSchema>;

export const PlatformInvitationStateSchema = z.enum(['pending', 'accepted', 'expired', 'revoked']);

export const PlatformInvitationSchema = z.object({
  id: IdSchema,
  email: z.string(),
  groups: z.array(z.string()),
  developer: z.boolean(),
  state: PlatformInvitationStateSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  /** The person, or the Platform key, that made it. A key's invitations end with the key. */
  createdBy: z.object({ kind: z.enum(['user', 'key']), id: IdSchema, name: z.string().nullable() }),
});
export type PlatformInvitation = z.infer<typeof PlatformInvitationSchema>;

/**
 * A created or resent invitation: the PassBook link is shown here once, only its hash is stored. A replay with the
 * same `Idempotency-Key` answers without it; revoke and send again if the first answer was lost.
 */
export const PlatformInvitationCreatedSchema = PlatformInvitationSchema.extend({
  link: z.string().optional(),
});
export type PlatformInvitationCreated = z.infer<typeof PlatformInvitationCreatedSchema>;

export const PlatformInvitationListSchema = pageOf(PlatformInvitationSchema);
