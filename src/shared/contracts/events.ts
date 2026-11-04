import { z } from 'zod';
import {
  IdSchema,
  JsonSchema,
  ModeSchema,
  PageQuerySchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/** Closed list: a new kind is added here, never invented at a call site. */
export const EVENT_KINDS = [
  'pass.issued',
  'pass.updated',
  'pass.voided',
  'pass.unvoided',
  'pass.removed',
  'pass.restored',
  'pass.link_rotated',
  'email.queued',
  'email.sent',
  'email.failed',
  'email.captured',
  'page.opened',
  'pass.downloaded',
  'bundle.opened',
  'bundle.downloaded',
  'device.registered',
  'device.unregistered',
  'device.fetched',
  'device.log',
  'push.queued',
  'push.sent',
  'push.failed',
  'scan.checked_in',
  'scan.redeemed',
  'scan.adjusted',
  'scan.rejected',
  'message.applied',
  'schedule.applied',
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventActorTypeSchema = z.enum([
  'user',
  'api_key',
  'system',
  'connection',
  'device',
  'holder',
  'scanner',
]);
export type EventActorType = z.infer<typeof EventActorTypeSchema>;

export const PassEventSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  mode: ModeSchema,
  kind: EventKindSchema,
  /** First 12 hex characters of SHA-256(device id). */
  device: z.string().nullable(),
  actorType: EventActorTypeSchema.nullable(),
  actorId: z.string().nullable(),
  /** Never holds emails, tokens, push tokens or personalization values. */
  data: z.record(z.string(), JsonSchema),
  at: TimestampSchema,
});
export type PassEventDto = z.infer<typeof PassEventSchema>;

/** Sync log filters: a named group of kinds. */
export const EVENT_GROUPS = {
  delivery: [
    'email.queued',
    'email.sent',
    'email.failed',
    'email.captured',
    'push.queued',
    'push.sent',
    'push.failed',
  ],
  devices: [
    'device.registered',
    'device.unregistered',
    'device.fetched',
    'device.log',
    'page.opened',
    'pass.downloaded',
    'bundle.opened',
    'bundle.downloaded',
  ],
  changes: [
    'pass.issued',
    'pass.updated',
    'pass.voided',
    'pass.unvoided',
    'pass.removed',
    'pass.restored',
    'pass.link_rotated',
    'message.applied',
    'schedule.applied',
  ],
} as const satisfies Record<string, readonly EventKind[]>;
export const EventGroupSchema = z.enum(['delivery', 'devices', 'changes']);
export type EventGroup = z.infer<typeof EventGroupSchema>;

const KindListSchema = z
  .string()
  .max(600)
  .transform((raw) => raw.split(',').map((k) => k.trim()))
  .pipe(z.array(EventKindSchema).min(1).max(EVENT_KINDS.length));

/** `kind` takes one kind or a comma list; `group` a named set. Both together are combined. */
export const PassEventListQuerySchema = PageQuerySchema.extend({
  kind: KindListSchema.optional(),
  group: EventGroupSchema.optional(),
});
export const PassEventListSchema = pageOf(PassEventSchema);

export const DeviceStatusSchema = z.enum([
  'current',
  'waiting',
  'push_failing',
  'removed',
  'unknown',
]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const PassSyncDeviceSchema = z.object({
  /** First 12 hex characters of SHA-256(device id). */
  device: z.string(),
  status: DeviceStatusSchema,
  registeredAt: TimestampSchema.nullable(),
  unregisteredAt: TimestampSchema.nullable(),
  lastFetch: z
    .object({ at: TimestampSchema, version: z.number().int(), httpStatus: z.number().int() })
    .nullable(),
  lastPush: z
    .object({
      at: TimestampSchema,
      ok: z.boolean(),
      version: z.number().int().nullable(),
      httpStatus: z.number().int().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  /** Only after a remove: fetched the removal version, deleted by the holder, or still waiting. */
  removal: z.enum(['pending', 'fetched', 'deleted']).nullable(),
});
export type PassSyncDeviceDto = z.infer<typeof PassSyncDeviceSchema>;

export const PassDevicesSchema = z.object({
  /** The pass's current version, which "Up to date" is measured against. */
  version: z.number().int(),
  devices: z.array(PassSyncDeviceSchema),
  removal: z
    .object({
      removedAt: TimestampSchema,
      version: z.number().int().nullable(),
      total: z.number().int(),
      done: z.number().int(),
    })
    .nullable(),
});
export type PassDevicesDto = z.infer<typeof PassDevicesSchema>;

export const REMOVE_MESSAGE_MAX = 200;
export const RemovePassSchema = z.object({
  /** Shown to holders on the lock screen; omit for a silent removal. */
  message: z.string().trim().max(REMOVE_MESSAGE_MAX).optional(),
});
