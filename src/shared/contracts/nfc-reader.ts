import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import {
  ReaderErrorCodeSchema,
  ReaderPinnedBySchema,
  type ReaderState,
  ReaderText,
} from './reader-bridge.ts';

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
  pinnedBy: ReaderPinnedBySchema,
  label: ReaderText(40).nullable(),
  firmware: ReaderText(32).nullable(),
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

/** The device roles that scan, and so may use an external reader. */
export type NfcReaderRole = 'scan' | 'kiosk';

/** Staff devices use a reader by default; kiosks, which nobody watches, do not. */
export const defaultNfcReaderSettings = (role: NfcReaderRole): NfcReaderSettings => ({
  use: role === 'scan',
  model: 'any',
  connection: 'auto',
});

/** One rule for the server and every client: may cards be read from this reader on this device? */
export function readerMayRead(args: {
  role: NfcReaderRole;
  settings: Pick<NfcReaderSettings, 'use'>;
  reader: Pick<ReaderState, 'pinned' | 'pinnedBy'>;
}): boolean {
  if (!args.settings.use) return false;
  if (args.role === 'kiosk') return args.reader.pinned && args.reader.pinnedBy === 'staffMenu';
  return true;
}
