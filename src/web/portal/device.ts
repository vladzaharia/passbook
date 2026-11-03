import { type DeviceInfo, passDevice } from '../../shared/device.ts';

/** This browser under the shared device rule (shared/device.ts): its touch points tell an iPad. */
export const browserDevice = (): DeviceInfo =>
  passDevice(navigator.userAgent, navigator.maxTouchPoints);
