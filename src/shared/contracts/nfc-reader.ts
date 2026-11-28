import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import { ReaderErrorCodeSchema } from './reader-bridge.ts';

/** An external NFC reader on a Staff device or a kiosk: the admin's setting, and what the device reports. */
export const NfcReaderSettingsSchema = z.strictObject({
  use: z.boolean(),
  model: z.enum(['any', 'acr1555u', 'acr1552u']),
  connection: z.enum(['auto', 'usb', 'bluetooth', 'keyboard']),
});
export const NfcReaderStatusSchema = z.strictObject({
  state: z.enum(['none', 'ready', 'connecting', 'disconnected', 'standby', 'error', 'keyboard']),
  model: z.enum(['acr1555u', 'acr1552u', 'ccid']).nullable(),
  transport: z.enum(['usb', 'bluetooth', 'web-bluetooth', 'keyboard']).nullable(),
  pinned: z.boolean(),
  label: z.string().max(40).nullable(),
  firmware: z.string().max(32).nullable(),
  battery: z
    .strictObject({
      percent: z.number().int().min(0).max(100).nullable(),
      low: z.boolean(),
      charging: z.boolean().nullable(),
    })
    .nullable(),
  code: ReaderErrorCodeSchema.nullable(),
  reportedAt: TimestampSchema,
});
export type NfcReaderSettings = z.infer<typeof NfcReaderSettingsSchema>;
export type NfcReaderStatus = z.infer<typeof NfcReaderStatusSchema>;
