import { z } from 'zod';
import { normalizeEmail, strictEmail } from '../email.ts';
import { INVITE_SECRET } from '../invitation-link.ts';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

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
  /** The org is a personal org. Its owner sees it named "Personal" in their own list. */
  personal: z.boolean().default(false),
  /** A developer sandbox: it never holds Live, so the console opens it in Test. */
  testOnly: z.boolean().optional(),
  userId: IdSchema,
  roles: OrgRolesSchema,
  capabilities: z.array(OrgCapabilitySchema),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type OrgMembership = z.infer<typeof OrgMembershipSchema>;
/** `nextCursor` is optional in the type only: the session fixtures in the web tests predate it. The server always sends it. */
export const OrgMembershipListSchema = pageOf(OrgMembershipSchema).extend({
  nextCursor: z.string().nullable().optional(),
});

/** A member as org managers see them: the person, not just the user id. */
export const OrgMemberSchema = OrgMembershipSchema.extend({
  userName: z.string().nullable(),
  /** The address to show; null for an account with no verified email (never the placeholder). */
  userEmail: z.string().nullable(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;
export const OrgMemberListSchema = pageOf(OrgMemberSchema);

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
export const OrgInvitationListSchema = pageOf(OrgInvitationSchema);

export const InvitationEmailSchema = z
  .string()
  .transform(normalizeEmail)
  .refine((email) => strictEmail(email) !== null, 'Enter a valid email address.');

export const InviteOrgMemberSchema = z.strictObject({
  email: InvitationEmailSchema,
  roles: OrgRolesSchema,
});
export type InviteOrgMember = z.infer<typeof InviteOrgMemberSchema>;

/** Organization admin covers every role and Read only conflicts with any other: each stands alone. */
export const ChangeOrgMemberRolesSchema = z.strictObject({
  roles: OrgRolesSchema.refine(
    (roles) =>
      roles.length === 1 || !roles.some((role) => role === 'org_admin' || role === 'read_only'),
    'Organization admin and Read only cannot be combined with other roles.',
  ),
});
export type ChangeOrgMemberRoles = z.infer<typeof ChangeOrgMemberRolesSchema>;

export const AcceptOrgInvitationSchema = z.strictObject({
  token: z.string().regex(INVITE_SECRET),
});
export const OrgInvitationPreviewSchema = z.object({ orgName: z.string() });

export const OrgMembershipParamSchema = z.object({ id: IdSchema, membershipId: IdSchema });
export const OrgInvitationParamSchema = z.object({ id: IdSchema, invitationId: IdSchema });
