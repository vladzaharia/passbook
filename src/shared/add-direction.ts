import { type DeviceInfo, showsAddQr } from './device.ts';

/**
 * Three explorations of the pass page's add block and header, picked with `?add=a|b|c` where
 * `allowed` (a dev build; a /p served from localhost). Without one the page keeps its layout.
 * a: the add card. b: the iPhone. c: the buddy.
 */
export type AddDirection = 'a' | 'b' | 'c';

export function addDirection(search: string, allowed: boolean): AddDirection | null {
  if (!allowed) return null;
  const value = new URLSearchParams(search).get('add');
  return value === 'a' || value === 'b' || value === 'c' ? value : null;
}

/**
 * What the add block does. scan: the QR leads (not the phone). phone: the badge leads (the
 * iPhone). added: on a device already, so a quiet confirmation, adding again on request. off:
 * voided or expired, nothing to add.
 */
export type AddMode = 'scan' | 'phone' | 'added' | 'off';

export function addMode(
  state: 'active' | 'voided' | 'expired',
  device: DeviceInfo,
  inWallet: boolean,
  publicUrl: string | null,
): AddMode {
  if (state !== 'active') return 'off';
  if (inWallet) return 'added';
  return publicUrl !== null && showsAddQr(device.device) ? 'scan' : 'phone';
}
