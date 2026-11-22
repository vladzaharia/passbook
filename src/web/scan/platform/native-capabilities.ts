import { sanitizeNativeHardware } from '../../../shared/contracts/scan-hardware.ts';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';

export const NATIVE_CAPABILITIES_EVENT = 'passbook:native-capabilities';
let current: NativeScannerCapabilities | undefined;

/** The schema loads on the first native report, not with the first paint (it pulls most of the contracts). */
export async function setNativeCapabilities(value: unknown): Promise<void> {
  const { NativeScannerCapabilitiesSchema } = await import(
    '../../../shared/contracts/scanning-sessions.ts'
  );
  const raw = value as { hardware?: unknown } | null;
  // A newer shell's hardware list must not cost the whole snapshot.
  const parsed = NativeScannerCapabilitiesSchema.safeParse(
    raw && typeof raw === 'object' && 'hardware' in raw
      ? { ...raw, hardware: sanitizeNativeHardware(raw.hardware) }
      : value,
  );
  if (!parsed.success) return;
  current = parsed.data;
  window.dispatchEvent(new CustomEvent(NATIVE_CAPABILITIES_EVENT, { detail: current }));
}

export function getNativeCapabilities(): NativeScannerCapabilities | undefined {
  return current;
}

export function clearNativeCapabilities(): void {
  current = undefined;
  window.dispatchEvent(new CustomEvent(NATIVE_CAPABILITIES_EVENT, { detail: null }));
}
