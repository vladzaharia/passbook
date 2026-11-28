import { z } from 'zod';
import { ROSTER_MAX_ENTRIES } from '../scan-offline.ts';
import { IdSchema, PlainLineSchema, TimestampSchema } from './common.ts';
import { UuidV7Schema } from './scan.ts';
import { ScanHelpStateSchema } from './scan-help.ts';
import { KioskHostResultSchema } from './scan-hosts.ts';
import {
  KioskCodeSchema,
  KioskConfigSchema,
  KioskConfirmSchema,
  KioskHeartbeatResultSchema,
  KioskHeartbeatSchema,
  KioskLookupSchema,
  KioskStaffAdmitSchema,
  KioskStaffExitSchema,
  KioskViewSchema,
  KioskWalkInSchema,
} from './scan-kiosk.ts';

/** `POST /scan`: camera, HID or NFC only. No manual entry, no raw pass id. */
export const KioskScanSchema = z.strictObject({
  code: z.string().min(1).max(1024),
  method: z.enum(['camera', 'hid', 'nfc']),
});

/** `POST /scan/help`: the kiosk raises its own help or asks for an approval of its own scan. */
export const KioskHelpRaiseSchema = z.union([
  z.strictObject({ topic: z.literal('kiosk_help'), idempotencyKey: IdSchema }),
  z.strictObject({ topic: z.literal('kiosk_admit'), scanId: IdSchema, idempotencyKey: IdSchema }),
]);
/** `POST /scan/help` and `GET /scan/help/{id}` answer with this, never `ScanHelpRequestSchema`. */
export const KioskHelpViewSchema = z.strictObject({
  id: IdSchema,
  state: ScanHelpStateSchema,
  expiresAt: TimestampSchema,
  /** The `admit` handle once a `kiosk_admit` is approved (K-D18). */
  handle: z.string().min(1).max(128).optional(),
  onTheWay: z.boolean(),
});

/** `GET /scan/kiosk/roster`: hashes and state only, as the staff roster, with no group ordinals. */
export const KioskRosterSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        h: z.string().regex(/^[0-9a-f]{32}$/),
        status: z.enum(['active', 'voided', 'removed']),
        state: z.enum(['in', 'out']).nullable(),
        day: z.boolean().optional(),
      }),
    )
    .max(ROSTER_MAX_ENTRIES),
  cursor: z.string().max(128).nullable(),
  asOf: TimestampSchema,
  validUntil: TimestampSchema,
  sig: z.string().max(64).optional(),
});
/** `POST /scan/kiosk/batch`: reads queued while offline; check-in only, so no override or door verdict. */
export const KioskBatchRequestSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        idempotencyKey: UuidV7Schema,
        code: z.string().min(1).max(1024),
        method: KioskScanSchema.shape.method,
        clientTs: TimestampSchema,
      }),
    )
    .min(1)
    .max(50),
  roster: z
    .strictObject({ asOf: TimestampSchema, validUntil: TimestampSchema, sig: z.string().max(64) })
    .optional(),
});
export const KioskBatchResultSchema = z.strictObject({
  items: z.array(z.strictObject({ idempotencyKey: UuidV7Schema, synced: z.boolean() })),
});
/** `GET /scan/kiosk/live`: what the hub tells a kiosk. No rows, no names, no outcomes. */
export const KioskLiveEventSchema = z.strictObject({
  kind: z.enum(['handoff_opened', 'help_updated', 'config_changed', 'paused', 'resumed']),
  /** The kiosk's own handoff or help request. */
  id: IdSchema.optional(),
});
export const KioskLiveSnapshotSchema = z.strictObject({
  cursor: z.string().max(64).nullable(),
  events: z.array(KioskLiveEventSchema).max(50),
});
/** `POST /scan/kiosk/staff/lookup`, under the staff PIN session: handles only `…/staff/admit` accepts. */
export const KioskStaffLookupSchema = z.strictObject({ q: z.string().trim().min(2).max(80) });
export const KioskStaffLookupResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        handle: z.string().min(1).max(128),
        firstName: PlainLineSchema(24),
        lastInitial: z.string().min(1).max(2),
        serialTail: z.string().regex(/^[0-9]{2}$/),
      }),
    )
    .max(4),
});

type KioskEndpoint = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Null: no body, or a shared staff-session body that carries no scan data. */
  request: z.ZodType | null;
  response: z.ZodType | null;
};
const ep = (
  method: KioskEndpoint['method'],
  path: string,
  request: z.ZodType | null,
  response: z.ZodType | null,
): KioskEndpoint => ({ method, path, request, response });

/**
 * The only device endpoints a kiosk may call (K-D2); anything else is 403 `KIOSK_NOT_ALLOWED`.
 * Each names the kiosk schemas it takes and answers with, never a staff one.
 */
export const KIOSK_ALLOWED_ENDPOINTS: readonly KioskEndpoint[] = [
  ep('GET', '/scan/kiosk/config', null, KioskConfigSchema),
  ep('POST', '/scan/kiosk/heartbeat', KioskHeartbeatSchema, KioskHeartbeatResultSchema),
  ep('POST', '/scan', KioskScanSchema, KioskViewSchema),
  ep('POST', '/scan/kiosk/lookup', KioskLookupSchema, KioskViewSchema),
  ep('POST', '/scan/kiosk/code', KioskCodeSchema, KioskViewSchema),
  ep('POST', '/scan/kiosk/confirm', KioskConfirmSchema, KioskViewSchema),
  ep('GET', '/scan/kiosk/hosts', null, KioskHostResultSchema),
  ep('POST', '/scan/kiosk/walk-in', KioskWalkInSchema, KioskViewSchema),
  ep('POST', '/scan/kiosk/handoff/{id}/revoke', null, null),
  ep('GET', '/scan/kiosk/roster', null, KioskRosterSchema),
  ep('POST', '/scan/kiosk/batch', KioskBatchRequestSchema, KioskBatchResultSchema),
  ep('GET', '/scan/kiosk/live', null, KioskLiveSnapshotSchema),
  ep('POST', '/staff/pin', null, null),
  ep('DELETE', '/staff', null, null),
  ep('POST', '/scan/kiosk/staff/lookup', KioskStaffLookupSchema, KioskStaffLookupResultSchema),
  ep('POST', '/scan/kiosk/staff/admit', KioskStaffAdmitSchema, KioskViewSchema),
  ep('POST', '/scan/kiosk/staff/pause', null, null),
  ep('POST', '/scan/kiosk/staff/resume', null, null),
  ep('POST', '/scan/kiosk/staff/exit', KioskStaffExitSchema, null),
  ep('POST', '/scan/help', KioskHelpRaiseSchema, KioskHelpViewSchema),
  ep('POST', '/scan/help/{id}/cancel', null, KioskHelpViewSchema),
  ep('GET', '/scan/help/{id}', null, KioskHelpViewSchema),
];
