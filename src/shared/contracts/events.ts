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
  'device',
  'holder',
  'scanner',
]);

export const PassEventSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  mode: ModeSchema,
  kind: EventKindSchema,
  /** First 12 hex characters of SHA-256(device id). */
  device: z.string().nullable(),
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  /** Never holds emails, tokens, push tokens or personalization values. */
  data: z.record(z.string(), JsonSchema),
  at: TimestampSchema,
});
export type PassEventDto = z.infer<typeof PassEventSchema>;

export const PassEventListQuerySchema = PageQuerySchema.extend({
  kind: EventKindSchema.optional(),
});
export const PassEventListSchema = pageOf(PassEventSchema);
