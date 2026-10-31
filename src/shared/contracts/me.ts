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
  /** Image files the pass can load: template files plus per-pass overrides. */
  assetNames: z.array(z.string()),
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
  /** Seconds before the next refresh is accepted (settings refresh.userCooldownSeconds). */
  cooldownSeconds: z.number().int(),
});

/** GET /api/v1/me/passes.pkpasses?part=N: my active passes as .pkpasses bundles of up to 10. */
export const MY_PASSES_BUNDLE_PATH = '/api/v1/me/passes.pkpasses';
export const MY_PASSES_BUNDLE_SIZE = 10;
/** Response header with the number of bundles (parts) available. */
export const MY_PASSES_BUNDLE_PARTS_HEADER = 'x-bundle-parts';
export const MyBundleQuerySchema = z.object({
  part: z.coerce.number().int().min(1).max(1000).default(1),
});
