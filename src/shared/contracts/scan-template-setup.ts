import { z } from 'zod';
import { IdSchema } from './common.ts';
import { TimeZoneSchema } from './scan-base.ts';

/** One call: the events and the session that scan a template's passes. Idempotent. */
export const TemplateScanSetupBodySchema = z.strictObject({
  orgId: IdSchema,
  /** The session's zone: the console's. Absent: the first event's zone, else UTC. */
  timeZone: TimeZoneSchema.optional(),
});
export const TemplateScanSetupSchema = z.object({
  session: z.object({ id: IdSchema, name: z.string() }),
  /** False when a live session already scanned the template: it only gained the events below. */
  created: z.boolean(),
  /** The events this call put on the session; `created` is false for one that already existed. */
  events: z.array(z.object({ id: IdSchema, name: z.string(), created: z.boolean() })).max(10),
  /** The template names its event on each pass, and no pass has an upcoming one yet. */
  noEvents: z.boolean(),
});
export type TemplateScanSetup = z.infer<typeof TemplateScanSetupSchema>;
