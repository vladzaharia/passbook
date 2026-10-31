import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

export const MyPassSchema = z.object({
  id: IdSchema,
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  templateName: z.string(),
  orgName: z.string(),
  status: z.enum(['active', 'voided']),
  modifiedAt: TimestampSchema,
  lastRefreshedAt: TimestampSchema.nullable(),
  refreshRequestedAt: TimestampSchema.nullable(),
  downloadUrl: z.string(),
  passJson: z.record(z.string(), z.unknown()),
  assetBaseUrl: z.string(),
});
export const MyPassListSchema = pageOf(MyPassSchema);

export const MyEmailSchema = z.object({
  email: z.string(),
  verifiedAt: TimestampSchema.nullable(),
  verifiedVia: z.enum(['magic_link', 'oidc', 'admin']).nullable(),
  primary: z.boolean(),
});
export const MyEmailListSchema = z.object({ items: z.array(MyEmailSchema) });
export const AddEmailRequestSchema = z.object({ email: z.string().max(254) });

export const MySessionSchema = z.object({
  id: IdSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export const MySessionListSchema = z.object({ items: z.array(MySessionSchema) });

/** Adds an email and sends a verification magic link (purpose verify_email). */
export const RemovePassResponseSchema = z.object({ ok: z.literal(true) });
export const RefreshResponseSchema = z.object({
  accepted: z.literal(true),
  requestedAt: TimestampSchema,
});
