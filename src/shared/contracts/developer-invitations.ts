import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import { InvitationEmailSchema, OrgRoleSchema, OrgRolesSchema } from './org-membership.ts';

/** `roles` is optional: with none, the person gets developer access and no membership of the org. */
export const InviteDeveloperSchema = z.strictObject({
  email: InvitationEmailSchema,
  roles: OrgRolesSchema.optional(),
});
export type InviteDeveloper = z.infer<typeof InviteDeveloperSchema>;

export const DeveloperInvitationStateSchema = z.enum(['pending', 'revoked', 'expired']);

export const DeveloperInvitationSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  email: z.string(),
  /** The roles the person also joins the org with; empty for developer access alone. */
  roles: z.array(OrgRoleSchema),
  state: DeveloperInvitationStateSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type DeveloperInvitation = z.infer<typeof DeveloperInvitationSchema>;
export const DeveloperInvitationListSchema = pageOf(DeveloperInvitationSchema);

export const DeveloperSchema = z.object({
  userId: IdSchema,
  name: z.string().nullable(),
  email: z.string().nullable(),
  since: TimestampSchema,
  /** The org roles the person holds through the invitation; null without a membership. */
  roles: z.array(OrgRoleSchema).nullable(),
});
export type Developer = z.infer<typeof DeveloperSchema>;

export const DeveloperListSchema = pageOf(DeveloperSchema).extend({
  /** False when the plan has no developer seats or Polaris ID cannot be reached: the console hides the section. */
  available: z.boolean(),
  /** Developers plus pending invitations the plan allows; null for no limit. */
  limit: z.number().int().nullable(),
});
export type DeveloperList = z.infer<typeof DeveloperListSchema>;

export const DeveloperInvitationParamSchema = z.object({ id: IdSchema, invitationId: IdSchema });
export const DeveloperParamSchema = z.object({ id: IdSchema, userId: IdSchema });
