import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

/** How pushes reach Apple: the identity's mTLS certificate binding, the team's .p8 key, or neither. */
export const PushMethodSchema = z.enum(['certificate', 'key', 'none']);
export type PushMethod = z.infer<typeof PushMethodSchema>;

/** The team's APNs key; the secret never leaves the server. */
export const PushKeyInfoSchema = z.object({
  keyId: z.string(),
  createdAt: TimestampSchema,
  rotatedAt: TimestampSchema.nullable(),
  /** Identities of the team the key serves. */
  identityCount: z.number().int().nonnegative(),
  /** Identities of the team with no present binding, which push only with the key. */
  dependentCount: z.number().int().nonnegative(),
});

export const IdentitySchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  label: z.string(),
  passTypeIdentifier: z.string(),
  teamIdentifier: z.string(),
  source: z.enum(['env', 'db']),
  certSha256: z.string().nullable(),
  certSubject: z.string().nullable(),
  certSerial: z.string().nullable(),
  notBefore: TimestampSchema.nullable(),
  notAfter: TimestampSchema.nullable(),
  daysRemaining: z.number().int().nullable(),
  apnsBinding: z.string().nullable(),
  apnsAvailable: z.boolean(),
  pushMethod: PushMethodSchema.default('none'),
  pushKey: PushKeyInfoSchema.nullable().default(null),
  apnsHealth: z.enum(['unknown', 'healthy', 'failing']),
  /** The last APNs check (from the audit log) and Apple's reason code when it failed. */
  apnsCheckedAt: TimestampSchema.nullable().default(null),
  apnsReason: z.string().nullable().default(null),
  /** Passes signed with this identity (stops counting at 100000). */
  passCount: z.number().int().nonnegative().default(0),
  nfcEnabled: z.boolean(),
  isDefault: z.boolean(),
  createdAt: TimestampSchema,
});
export type IdentityDto = z.infer<typeof IdentitySchema>;
/** Oldest first (the platform identity leads); `cursor` is the last id of the previous page. */
export const IdentityListSchema = pageOf(IdentitySchema);

export const UploadIdentitySchema = z.object({
  orgId: IdSchema.nullable().optional(),
  label: z.string().min(1).max(120),
  certificatePem: z.string().min(1).max(20_000).optional(),
  privateKeyPem: z.string().min(1).max(20_000).optional(),
  pkcs12Base64: z.string().max(100_000).optional(),
  pkcs12Password: z.string().max(200).optional(),
  nfcEnabled: z.boolean().optional(),
});
export const UpdateIdentitySchema = z.object({
  label: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  nfcEnabled: z.boolean().optional(),
  apnsBinding: z.string().max(64).nullable().optional(),
});
export const ApnsProbeResultSchema = z.object({
  health: z.enum(['healthy', 'failing', 'inconclusive', 'unavailable']),
  status: z.number().int(),
  reason: z.string().nullable(),
  checkedAt: TimestampSchema,
  method: PushMethodSchema.default('none'),
});
export type ApnsProbeResult = z.infer<typeof ApnsProbeResultSchema>;
/** Replaces the certificate and key of an identity; pass type and team IDs must match. */
export const RotateIdentitySchema = z.object({
  certificatePem: z.string().min(1).max(20_000).optional(),
  privateKeyPem: z.string().min(1).max(20_000).optional(),
  pkcs12Base64: z.string().max(100_000).optional(),
  pkcs12Password: z.string().max(200).optional(),
});
/** An APNs auth key (.p8) for the identity's team, with its 10-character key ID. */
export const PushKeyInputSchema = z.object({
  keyId: z.string().min(1).max(20),
  p8: z.string().min(1).max(4_000),
});
