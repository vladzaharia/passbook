import type { ScanDeviceCapabilities, ScanSurface } from './contracts/scanning-sessions.ts';

export function reportedCapabilities(raw: ScanDeviceCapabilities): ScanDeviceCapabilities {
  const surfaces: ScanSurface[] = ['phone', 'operator', 'desk', 'customer'];
  return { ...raw, surfaces, preferred: raw.width >= 900 ? 'operator' : 'phone' };
}
export function surfaceFor(
  choice: string,
  capabilities: ScanDeviceCapabilities | null,
): ScanSurface {
  if (choice === 'auto') return capabilities?.preferred ?? 'phone';
  if (choice === 'desk' || choice === 'customer') return choice;
  return choice === 'operator' ? 'operator' : 'phone';
}
export const roleForSurface = (surface: ScanSurface | 'auto') =>
  surface === 'customer'
    ? ('customer' as const)
    : surface === 'desk'
      ? ('monitor' as const)
      : ('scan' as const);

export const SCAN_SURFACE_LABELS: Record<ScanSurface | 'auto', string> = {
  auto: 'Automatic',
  phone: 'Scanner',
  operator: 'Operator',
  desk: 'Desk display',
  customer: 'Customer display',
};
