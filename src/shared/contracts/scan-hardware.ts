import { z } from 'zod';

/** Bridge wire v1: what the native shell found. Names and ids stay on the device. */
export const NativeHardwareKindSchema = z.enum([
  'camera',
  'barcode',
  'nfc',
  'keyboard',
  'usb',
  'bluetooth',
  'display',
  'haptics',
  'speaker',
]);
export const NativeHardwareStateSchema = z.enum([
  'ready',
  'active',
  'off',
  'needs-permission',
  'unavailable',
  'error',
]);
export const NATIVE_HARDWARE_MAX = 16;

export const NativeHardwareEntrySchema = z.strictObject({
  kind: NativeHardwareKindSchema,
  /** Stable for the session; never a serial or MAC. */
  id: z.string().min(1).max(64),
  /** The OS's name, shown on the device only. */
  name: z.string().max(80).optional(),
  builtIn: z.boolean(),
  /** Null when the OS cannot tell. */
  connected: z.boolean().nullable(),
  state: NativeHardwareStateSchema,
  facing: z.enum(['front', 'back', 'external']).optional(),
  trigger: z.enum(['side', 'pistol', 'none', 'unknown']).optional(),
  reason: z.string().max(120).optional(),
});
export type NativeHardwareEntry = z.infer<typeof NativeHardwareEntrySchema>;

/** A list a newer shell sends: unknown or malformed entries drop alone, and at most 16 are kept. */
export function sanitizeNativeHardware(value: unknown): NativeHardwareEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: NativeHardwareEntry[] = [];
  for (const raw of value) {
    const parsed = NativeHardwareEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    if (entries.length === NATIVE_HARDWARE_MAX) break;
  }
  return entries;
}

/** What a device reports to the server: kinds and counts, never names or ids. */
export const ReportedHardwareSchema = z.strictObject({
  kind: z.enum([
    'camera',
    'barcode',
    'nfc',
    'nfc-reader',
    'keyboard',
    'usb',
    'hid',
    'serial',
    'bluetooth',
    'display',
  ]),
  count: z.number().int().min(1).max(NATIVE_HARDWARE_MAX),
  builtIn: z.boolean(),
  connected: z.boolean().nullable(),
  state: NativeHardwareStateSchema,
});
export type ReportedHardware = z.infer<typeof ReportedHardwareSchema>;
