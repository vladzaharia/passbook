import {
  type NativeScannerCapabilities,
  NativeScannerCapabilitiesSchema,
} from '../../../shared/contracts/scanning-sessions.ts';

export const NATIVE_CAPABILITIES_EVENT = 'passbook:native-capabilities';
let current: NativeScannerCapabilities | undefined;

export function setNativeCapabilities(value: unknown): void {
  const parsed = NativeScannerCapabilitiesSchema.safeParse(value);
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
