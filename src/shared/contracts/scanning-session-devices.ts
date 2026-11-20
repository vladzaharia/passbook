import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { ScanSurfaceSchema } from './scanning-sessions.ts';

/** The scanners of this device's session, for a Desk or Manager: who is connected now. */
export const SessionDevicesSchema = z.object({
  items: z
    .array(
      z.object({
        id: IdSchema,
        name: z.string(),
        surface: ScanSurfaceSchema,
        /** An open hub socket, or contact within two minutes. */
        online: z.boolean(),
        lastSeenAt: TimestampSchema.nullable(),
        /** The device asking. */
        self: z.boolean(),
      }),
    )
    .max(50),
});
export type SessionDevices = z.infer<typeof SessionDevicesSchema>;
