import { z } from 'zod';
import { IdSchema, pageOf, RoleSchema, TimestampSchema } from './common.ts';
import { PassStatusSchema } from './passes.ts';

export const UserSchema = z.object({
  id: IdSchema,
  name: z.string().nullable(),
  primaryEmail: z.string(),
  status: z.enum(['active', 'disabled']),
  lastRoles: z.array(RoleSchema),
  createdAt: TimestampSchema,
  lastLoginAt: TimestampSchema.nullable(),
});
export const UserListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const UserListSchema = pageOf(UserSchema);

export const UserDetailSchema = UserSchema.extend({
  emails: z.array(
    z.object({
      email: z.string(),
      verifiedVia: z.enum(['magic_link', 'oidc', 'admin']),
      verifiedAt: TimestampSchema,
    }),
  ),
  identities: z.array(
    z.object({
      provider: z.string(),
      subject: z.string(),
      emailClaim: z.string().nullable(),
      emailVerified: z.boolean(),
      groups: z.array(z.string()),
      lastUsedAt: TimestampSchema.nullable(),
    }),
  ),
  sessions: z.array(
    z.object({
      id: IdSchema,
      amr: z.enum(['oidc', 'magic_link', 'breakglass']),
      roles: z.array(RoleSchema),
      createdAt: TimestampSchema,
      lastSeenAt: TimestampSchema,
      expiresAt: TimestampSchema,
      revokedAt: TimestampSchema.nullable(),
      userAgent: z.string().nullable(),
    }),
  ),
  /** First 100 owned passes (title falls back to the serial); `passCount` is the total. */
  passes: z.array(
    z.object({
      id: IdSchema,
      title: z.string(),
      templateName: z.string(),
      orgName: z.string(),
      status: PassStatusSchema,
    }),
  ),
  passCount: z.number().int().nonnegative(),
  recentAudit: z.array(
    z.object({
      id: z.number().int(),
      at: TimestampSchema,
      action: z.string(),
      actorType: z.string(),
      actorId: z.string().nullable(),
    }),
  ),
});
export const UpdateUserSchema = z.object({ status: z.enum(['active', 'disabled']) });
export const AddUserEmailSchema = z.object({ email: z.string().max(254) });
