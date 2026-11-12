import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';
import { BrandingImageSchema, OrgBrandingSchema } from './orgs.ts';
import {
  CodeFormatSchema,
  ScanActionKindSchema,
  ScanAdminScopeSchema,
  ScanCountsSchema,
  ScanDirectionSchema,
  ScanMethodSchema,
  ScannerSettingsSchema,
  ScanOutcomeSchema,
  ScanReasonSchema,
  ScanRecordOutcomeSchema,
  ScanRoleSchema,
  ScanValueSchema,
  UuidV7Schema,
} from './scan.ts';
import { DeviceRoleSchema, ScannerKindSchema } from './scanners.ts';
import { ScanWorkspaceSchema } from './scanning-sessions.ts';

/** The device API's session, pairing, staff, lookup, recent, summary and offline shapes (SA 4.2). */

const SessionTemplateSchema = z.object({
  id: IdSchema,
  name: z.string(),
  style: z.string(),
  formats: z.array(CodeFormatSchema),
  actions: z.array(z.object({ id: z.string(), label: z.string(), kind: ScanActionKindSchema })),
});
const SessionStaffSchema = z.object({ id: IdSchema, name: z.string(), role: ScanRoleSchema });

/** `GET /scan/staff?q=`: people matching a name, when the sign-in roster was cut. */
export const ScanStaffSearchSchema = z.object({ items: z.array(SessionStaffSchema) });

export const ScanBrandingSchema = z.strictObject({
  accent: OrgBrandingSchema.shape.accent.unwrap().nullable(),
  logo: BrandingImageSchema.nullable(),
});
export type ScanBranding = z.infer<typeof ScanBrandingSchema>;

export const ScanSessionSchema = z.object({
  workspace: ScanWorkspaceSchema.nullable().optional(),
  principal: z.enum(['scanner', 'admin']),
  state: z.enum(['ready', 'staff_required', 'not_open', 'closed', 'unassigned']),
  branding: ScanBrandingSchema.optional(),
  scanner: z
    .object({
      id: IdSchema,
      name: z.string(),
      kind: ScannerKindSchema,
      deviceRole: DeviceRoleSchema,
      mode: ModeSchema,
      orgId: IdSchema,
      orgName: z.string(),
      timeZone: z.string(),
      settings: ScannerSettingsSchema,
    })
    .nullable(),
  admin: z
    .object({ name: z.string(), orgs: z.array(z.object({ id: IdSchema, name: z.string() })) })
    .nullable(),
  event: z
    .object({
      id: IdSchema,
      name: z.string(),
      opensAt: TimestampSchema,
      closesAt: TimestampSchema,
      timeZone: z.string(),
      reentry: z.boolean(),
      /** The event's staff note: Start panel, heads_up and refused. */
      note: z.string().max(140).nullable(),
    })
    .nullable(),
  templates: z.array(SessionTemplateSchema),
  formats: z.array(CodeFormatSchema),
  staff: SessionStaffSchema.nullable(),
  /** Only when staff sign-in is on. */
  staffList: z.array(SessionStaffSchema).nullable(),
  /** The roster was cut: search it with `GET /scan/staff?q=`. */
  staffTruncated: z.boolean().optional(),
  approvals: z.boolean(),
  csrfToken: z.string().nullable(),
  undoWindowMinutes: z.number().int(),
  counts: ScanCountsSchema,
});
export type ScanSession = z.infer<typeof ScanSessionSchema>;

export const ScanPairRequestSchema = z.object({ code: z.string().min(10).max(16) });
export const ScanPairPreviewSchema = z.object({
  scannerName: z.string(),
  orgName: z.string(),
  mode: ModeSchema,
});
export const ScanStaffSignInSchema = z.object({
  staffId: IdSchema,
  pin: z.string().regex(/^\d{6}$/),
});
export const ScanLookupRequestSchema = z.object({
  q: z.string().min(1).max(120),
  scope: ScanAdminScopeSchema.optional(),
});
export const ScanLookupRowSchema = z.object({
  passId: IdSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  templateName: z.string(),
  status: z.enum(['active', 'voided', 'expired', 'removed']),
  maskedEmail: z.string().nullable(),
  /** Only when the template's display sets `photo` and its minRole admits the actor's role. */
  photoUrl: z.string().nullable(),
  doorState: z.enum(['in', 'out']).nullable(),
  lastScanAt: TimestampSchema.nullable(),
});
export const ScanLookupResultSchema = z.object({
  items: z.array(ScanLookupRowSchema).max(10),
  more: z.boolean(),
});
export const ScanRecentSchema = z.object({
  items: z
    .array(
      z.object({
        scanId: IdSchema,
        at: TimestampSchema,
        outcome: ScanRecordOutcomeSchema,
        reason: ScanReasonSchema.nullable(),
        actionLabel: z.string(),
        title: z.string().nullable(),
        value: ScanValueSchema.nullable(),
        undoable: z.boolean(),
      }),
    )
    .max(20),
});
export const ScanSummarySchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  total: z.number().int(),
  ok: z.number().int(),
  headsUp: z.number().int(),
  refused: z.number().int(),
  undone: z.number().int(),
  byAction: z.array(
    z.object({
      actionId: z.string(),
      label: z.string(),
      count: z.number().int(),
      amount: z.number(),
    }),
  ),
  firstAt: TimestampSchema.nullable(),
  lastAt: TimestampSchema.nullable(),
});

// v2: offline roster and batch sync.
export const ScanRosterSchema = z.object({
  entries: z.array(
    z.object({
      h: z.string().regex(/^[0-9a-f]{32}$/),
      status: z.enum(['active', 'voided', 'removed']),
      state: z.enum(['in', 'out']).nullable(),
    }),
  ),
  cursor: z.string().nullable(),
  asOf: TimestampSchema,
  validUntil: TimestampSchema,
});
export const ScanBatchRequestSchema = z.object({
  items: z
    .array(
      z.object({
        idempotencyKey: UuidV7Schema,
        code: z.string().min(1).max(1024),
        method: ScanMethodSchema,
        clientTs: TimestampSchema,
        direction: ScanDirectionSchema.optional(),
        /** An offline heads-up never reached the server, so a queued override carries this, not `overrideOf`. */
        override: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export const ScanBatchResultSchema = z.object({
  items: z.array(z.object({ idempotencyKey: UuidV7Schema, outcome: ScanOutcomeSchema })),
});
