import { z } from 'zod';
import { normalizeEmail, strictEmail } from '../email.ts';
import { IdSchema, TimestampSchema } from './common.ts';

/** Organization roles are separate from the platform session roles. */
export const OrgRoleSchema = z.enum([
  'org_admin',
  'integration_admin',
  'template_author',
  'template_reviewer',
  'template_publisher',
  'pass_operator',
  'read_only',
]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

/** Capabilities granted by organization roles and enforced by resource APIs. */
export const OrgCapabilitySchema = z.enum([
  'org:read',
  'org:manage',
  'members:read',
  'members:manage',
  'integrations:read',
  'integrations:manage',
  'templates:read',
  'templates:author',
  'templates:review',
  'templates:publish',
  'passes:read',
  'passes:operate',
  'messages:read',
  'messages:manage',
  'scanning:read',
  'scanning:manage',
  'audit:read',
]);
export type OrgCapability = z.infer<typeof OrgCapabilitySchema>;

export const OrgRolesSchema = z
  .array(OrgRoleSchema)
  .min(1)
  .max(OrgRoleSchema.options.length)
  .refine((roles) => new Set(roles).size === roles.length, 'Each role may appear only once.');

export const OrgMembershipSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgName: z.string(),
  orgSlug: z.string(),
  userId: IdSchema,
  roles: OrgRolesSchema,
  capabilities: z.array(OrgCapabilitySchema),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type OrgMembership = z.infer<typeof OrgMembershipSchema>;
export const OrgMembershipListSchema = z.object({ items: z.array(OrgMembershipSchema) });

/** A member as org managers see them: the person, not just the user id. */
export const OrgMemberSchema = OrgMembershipSchema.extend({
  userName: z.string().nullable(),
  userEmail: z.string(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;
export const OrgMemberListSchema = z.object({ items: z.array(OrgMemberSchema) });

export const OrgInvitationSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  email: z.string(),
  roles: OrgRolesSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  acceptedAt: TimestampSchema.nullable(),
});
export type OrgInvitation = z.infer<typeof OrgInvitationSchema>;
export const OrgInvitationListSchema = z.object({ items: z.array(OrgInvitationSchema) });

const InvitationEmailSchema = z
  .string()
  .transform(normalizeEmail)
  .refine((email) => strictEmail(email) !== null, 'Enter a valid email address.');

export const InviteOrgMemberSchema = z.strictObject({
  email: InvitationEmailSchema,
  roles: OrgRolesSchema,
});
export type InviteOrgMember = z.infer<typeof InviteOrgMemberSchema>;

export const AcceptOrgInvitationSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const OrgInvitationPreviewSchema = z.object({ orgName: z.string() });

export const OrgMembershipParamSchema = z.object({ id: IdSchema, membershipId: IdSchema });
export const OrgInvitationParamSchema = z.object({ id: IdSchema, invitationId: IdSchema });
