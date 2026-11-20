import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { getNativeCapabilities } from './native-capabilities.ts';

/** A device with a native reader, or an operator's own panel, scans without the camera. */
export function cameraDisabledFor(session: ScanSession, scanner: ScanSession['scanner']): boolean {
  const layout =
    getNativeCapabilities()?.layout ?? session.workspace?.device.capabilities?.native?.layout;
  if (layout?.posture === 'unfolded' || layout?.posture === 'half-folded') return false;
  if (session.workspace?.device.effectiveSurface === 'operator') return true;
  const native = getNativeCapabilities() ?? session.workspace?.device.capabilities?.native;
  if (scanner?.settings.reader === 'barcode')
    return session.workspace?.device.capabilities?.nativeBarcode ?? native?.platform === 'android';
  return scanner?.settings.reader === 'nfc' && (native?.vas.available ?? false);
}
