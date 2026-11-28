import { z } from 'zod';
import type { DeviceRoleSchema } from './contracts/scanners.ts';
import {
  type ScanDeviceCapabilities,
  type ScanSurface,
  type ScanSurfaceChoice,
  ScanSurfaceChoiceSchema,
  ScanSurfaceSchema,
} from './contracts/scanning-sessions.ts';

type DeviceRole = z.infer<typeof DeviceRoleSchema>;
type ScreenOrStaff = Exclude<DeviceRole, 'kiosk'>;

export function reportedCapabilities(raw: ScanDeviceCapabilities): ScanDeviceCapabilities {
  const surfaces: ScanSurface[] = ['phone', 'operator'];
  return { ...raw, surfaces, preferred: raw.width >= 900 ? 'operator' : 'phone' };
}

/**
 * A Staff device's layout. `auto` picks only among `allowed`, the layouts the plan allows
 * (Console needs `scanning.desk`, surface model §5); Handheld is always allowed.
 */
export function surfaceFor(
  choice: ScanSurfaceChoice,
  capabilities: ScanDeviceCapabilities | null,
  allowed: readonly ScanSurface[] = ScanSurfaceSchema.options,
): ScanSurface {
  if (choice !== 'auto') return choice;
  const preferred = capabilities?.preferred ?? 'phone';
  return allowed.includes(preferred) ? preferred : 'phone';
}

/**
 * What `scanning_devices.surface` stores until SD12's migration: the old screen layouts
 * (`customer`, `desk`) mark a Customer screen and a Monitor. Storage only, never the wire.
 */
export const StoredSurfaceSchema = z.enum([...ScanSurfaceChoiceSchema.options, 'desk', 'customer']);
export const StoredEffectiveSurfaceSchema = z.enum([
  ...ScanSurfaceSchema.options,
  'desk',
  'customer',
]);
export type StoredSurface = z.infer<typeof StoredSurfaceSchema>;
export type StoredEffectiveSurface = z.infer<typeof StoredEffectiveSurfaceSchema>;

export function storedSurfaceFor(
  stored: string,
  capabilities: ScanDeviceCapabilities | null,
): StoredEffectiveSurface {
  if (stored === 'customer') return 'customer';
  // A stored `desk` choice folds into the Console: the acting monitor (SD12 removes it).
  if (stored === 'desk' || stored === 'operator') return 'operator';
  return stored === 'auto' ? surfaceFor('auto', capabilities) : 'phone';
}
export const roleOfStoredSurface = (surface: string): ScreenOrStaff =>
  surface === 'customer' ? 'customer' : surface === 'desk' ? 'monitor' : 'scan';
/** The stored layout for a new device of this kind. */
export const storedSurfaceOf = (
  role: ScreenOrStaff,
  surface: ScanSurfaceChoice | undefined,
): StoredSurface =>
  role === 'customer' ? 'customer' : role === 'monitor' ? 'desk' : (surface ?? 'auto');
/** The wire layout of a stored device: null on a Screen. */
export const wireSurface = <T extends string>(stored: T): Exclude<T, 'desk' | 'customer'> | null =>
  stored === 'desk' || stored === 'customer' ? null : (stored as Exclude<T, 'desk' | 'customer'>);

export const SCAN_SURFACE_LABELS: Record<ScanSurfaceChoice, string> = {
  auto: 'Automatic',
  phone: 'Handheld',
  operator: 'Console',
};
export const DEVICE_KIND_LABELS: Record<DeviceRole, string> = {
  scan: 'Staff device',
  customer: 'Customer screen',
  monitor: 'Monitor',
  kiosk: 'Kiosk',
};
