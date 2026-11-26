import { z } from 'zod';
import { HANDLE_PATTERN } from '../identity-handle.ts';
import { IdSchema, PageQuerySchema, pageOf, TimestampSchema } from './common.ts';
import { VasKeySchema } from './nfc.ts';

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

/** The platform's own identity slots: pass.mobile.passbook and the device-test pass type. */
export const PlatformSlotSchema = z.enum(['root', 'devtest']);
export const IdentityKindSchema = z.enum(['platform', 'managed', 'own']);
export const IdentityStatusSchema = z.enum([
  'provisioning',
  'active',
  'renewing',
  'expiring',
  'expired',
  'retired',
  'failed',
]);
export type IdentityStatus = z.infer<typeof IdentityStatusSchema>;
export const IdentityRotationSchema = z.enum(['auto', 'csr', 'manual']);

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
  /** Reader public keys, newest first. */
  nfcKeys: z.array(VasKeySchema).default([]),
  isDefault: z.boolean(),
  createdAt: TimestampSchema,
  kind: IdentityKindSchema.default('own'),
  status: IdentityStatusSchema.default('active'),
  rotation: IdentityRotationSchema.default('manual'),
  /** New passes may sign with it; false once stopped. */
  issuing: z.boolean().default(true),
  nextRotationAt: TimestampSchema.nullable().default(null),
  /** `pass.mobile.passbook.<handle>` for a managed identity. */
  handle: z.string().nullable().default(null),
});
export type IdentityDto = z.infer<typeof IdentitySchema>;
/** Oldest first (the platform identity leads); `cursor` is the last id of the previous page. */
export const IdentityListSchema = pageOf(IdentitySchema);

/** What an organization's member sees of its own identity: no binding name, push key or team-wide counts. */
export const OrgIdentitySchema = z.object({
  id: IdSchema,
  label: z.string(),
  passTypeIdentifier: z.string(),
  teamIdentifier: z.string(),
  certSubject: z.string().nullable(),
  certSerial: z.string().nullable(),
  notBefore: TimestampSchema.nullable(),
  notAfter: TimestampSchema.nullable(),
  daysRemaining: z.number().int().nullable(),
  apnsAvailable: z.boolean(),
  apnsHealth: z.enum(['unknown', 'healthy', 'failing']),
});
export type OrgIdentityDto = z.infer<typeof OrgIdentitySchema>;
export const OrgIdentityListSchema = pageOf(OrgIdentitySchema);

/** With `orgId`, only that organization's own identities; readable by a member with org:read. */
export const IdentityListQuerySchema = PageQuerySchema.extend({ orgId: IdSchema.optional() });

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
  /** `manual` pauses automatic renewal; `auto` needs a managed identity. */
  rotation: z.enum(['auto', 'manual']).optional(),
  /** `false` stops new passes from signing with the identity; existing passes keep working. */
  issuing: z.boolean().optional(),
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

/** A platform identity row: the identity plus what the platform view needs (design 8). */
export const PlatformIdentitySchema = IdentitySchema.extend({
  /** `null` for the legacy deployment identity. */
  slot: PlatformSlotSchema.nullable(),
  purpose: z.enum(['passes', 'device_test']),
  managed: z.enum(['connector', 'deployment']),
  /** Devices that registered a pass signed by this identity. */
  registrationCount: z.number().int().nonnegative(),
  openRunId: IdSchema.nullable(),
  /** The legacy identity once it signs nothing and is not the default. */
  dormant: z.boolean(),
});
export type PlatformIdentityDto = z.infer<typeof PlatformIdentitySchema>;
export const PlatformIdentityListSchema = z.object({
  items: z.array(PlatformIdentitySchema),
  /** The open setup run of each slot that has one. */
  openRuns: z.array(z.object({ slot: PlatformSlotSchema, runId: IdSchema })),
});
export const StartPlatformIdentitySchema = z.object({ slot: PlatformSlotSchema });
export const PlatformDefaultResultSchema = z.object({
  identityId: IdSchema,
  /** False when it already was the default. */
  changed: z.boolean(),
});

export const IdentityRunKindSchema = z.enum(['provision', 'rotate', 'revoke']);
export const IdentityRunStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
]);

export const IdentityRunSchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  kind: IdentityRunKindSchema,
  targetType: z.enum(['identity', 'org', 'wallet_credential']),
  targetId: IdSchema,
  state: IdentityRunStateSchema,
  step: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  waitingFor: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type IdentityRunDto = z.infer<typeof IdentityRunSchema>;
export const IdentityRunListSchema = pageOf(IdentityRunSchema);
export const IdentityRunListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  targetId: IdSchema.optional(),
});

/** The handle of `pass.mobile.passbook.<handle>`: 2 to 30 lowercase letters or digits, starting with a letter. */
export const IdentityHandleSchema = z.string().regex(HANDLE_PATTERN);
export const OrgIdParamSchema = z.object({ orgId: IdSchema });
export const StartManagedIdentitySchema = z.object({ handle: IdentityHandleSchema.optional() });

/** One row of the cross-provider list. Apple only until the Google and Samsung identities land. */
export const WalletIdentitySchema = z.object({
  id: IdSchema,
  provider: z.literal('apple'),
  orgId: IdSchema.nullable(),
  label: z.string(),
  identifier: z.string(),
  kind: IdentityKindSchema,
  status: IdentityStatusSchema,
  notBefore: TimestampSchema.nullable(),
  notAfter: TimestampSchema.nullable(),
  rotation: IdentityRotationSchema,
  nextRotationAt: TimestampSchema.nullable(),
  issuing: z.boolean(),
  isDefault: z.boolean(),
  passCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export type WalletIdentityDto = z.infer<typeof WalletIdentitySchema>;
export const WalletIdentityListSchema = pageOf(WalletIdentitySchema);
export const WalletIdentityListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  provider: z.literal('apple').default('apple'),
  kind: IdentityKindSchema.optional(),
  status: IdentityStatusSchema.optional(),
});

export const IdentityCertificateSchema = z.object({
  id: IdSchema,
  state: z.enum(['pending', 'active', 'superseded', 'revoked', 'failed']),
  origin: z.enum(['upload', 'asc', 'csr', 'env']),
  certSha256: z.string().nullable(),
  notBefore: TimestampSchema.nullable(),
  notAfter: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  activatedAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
});
export type IdentityCertificateDto = z.infer<typeof IdentityCertificateSchema>;
export const IdentityCertificateListSchema = z.object({
  items: z.array(IdentityCertificateSchema),
});

/** `confirm` is the pass type ID, typed by the admin. */
export const RevokeCertificateSchema = z.object({
  certificateId: IdSchema,
  reason: z.literal('compromised'),
  confirm: z.string().min(1).max(100),
});

export const AppleCallSchema = z.object({
  id: z.number().int(),
  callId: z.string(),
  phase: z.string(),
  method: z.string(),
  target: z.string().nullable(),
  caller: z.string().nullable(),
  status: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  at: TimestampSchema,
});
export const AppleCallListSchema = z.object({
  items: z.array(AppleCallSchema),
  /** False when the provisioner binding is not configured. */
  available: z.boolean(),
});
export const AppleCallQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
});
