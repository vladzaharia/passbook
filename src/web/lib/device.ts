import { Laptop, type LucideIcon, Smartphone, Tablet } from 'lucide-react';

/** Short device label from a user agent; the raw string is not useful in a list. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

export type DeviceKind = 'phone' | 'tablet' | 'computer';

export function deviceKind(ua: string | null): DeviceKind {
  if (!ua) return 'computer';
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return 'phone';
  return 'computer';
}

const DEVICE_ICON: Record<DeviceKind, LucideIcon> = {
  phone: Smartphone,
  tablet: Tablet,
  computer: Laptop,
};

/** The glyph for a session's device; also the This device pill's icon. */
export const deviceIcon = (ua: string | null): LucideIcon => DEVICE_ICON[deviceKind(ua)];
