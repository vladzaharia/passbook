import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  RoleSchema,
  TimestampSchema,
} from '../../../shared/contracts/common.ts';
import { OrgRolesSchema } from '../../../shared/contracts/org-membership.ts';
import { ScannerSettingsSchema, ScanRoleSchema } from '../../../shared/contracts/scan.ts';
import { eventSnapshot, scannerSnapshot } from './live-snapshot-schemas.ts';

const revisionNumber = z.number().int().nonnegative();
/** Validate without projecting away the original actor's private authority fields. */
export const liveActorSchema = z.strictObject({
  principal: z.enum(['scanner', 'admin']),
  orgId: IdSchema,
  mode: ModeSchema,
  actorKey: z.string().min(1),
  actor: z.strictObject({ type: z.enum(['scanner', 'user']), id: IdSchema }),
  scanner: scannerSnapshot,
  event: eventSnapshot.nullable(),
  templateIds: z.array(IdSchema),
  adminEventTemplates: z.boolean().optional(),
  invalidScannerScope: z.boolean().optional(),
  scannerAssignment: z
    .strictObject({
      scannerId: IdSchema,
      orgId: IdSchema,
      mode: ModeSchema,
      eventId: IdSchema.nullable(),
      event: eventSnapshot.nullable(),
      templateIds: z.array(IdSchema),
      templateRows: z.string(),
      structurallyValid: z.boolean(),
    })
    .nullable()
    .optional(),
  timeZone: z.string(),
  role: ScanRoleSchema.nullable(),
  staff: z
    .strictObject({
      id: IdSchema,
      name: z.string(),
      role: ScanRoleSchema,
      updatedAt: TimestampSchema,
    })
    .nullable(),
  settings: ScannerSettingsSchema.strict(),
  name: z.string(),
  terminal: z.boolean(),
  scannerCsrfProof: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  credentialKeysetCommitment: z.string().regex(/^[a-f0-9]{64}$/),
  scanningSession: z
    .strictObject({
      id: IdSchema,
      status: z.enum(['active', 'paused', 'ended']),
      updatedAt: TimestampSchema,
    })
    .optional(),
  platformSessionId: z.string().min(1).optional(),
  tenantAuthority: z
    .strictObject({
      kind: z.literal('session'),
      orgId: IdSchema,
      orgAccessRevision: revisionNumber,
      userId: IdSchema,
      userAccessRevision: revisionNumber.optional(),
      sessionId: z.string().min(1),
      membershipId: IdSchema,
      sessionCreatedAt: TimestampSchema,
      sessionExpiresAt: TimestampSchema,
      sessionCsrfProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      roles: OrgRolesSchema,
      sessionRoles: z.array(RoleSchema).min(1),
      amr: z.enum(['oidc', 'magic_link', 'breakglass']),
      capability: z.enum(['scanning:read', 'passes:operate']),
      mode: ModeSchema,
    })
    .optional(),
});
