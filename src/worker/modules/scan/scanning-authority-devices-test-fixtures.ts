/* istanbul ignore file -- @preserve */
import { registerScanningAuthorityDeviceAdmin } from './repo-scanning-authority-device-admin-test-fixtures.ts';
import { registerScanningAuthorityDeviceCredential } from './repo-scanning-authority-device-credential-test-fixtures.ts';

export function registerScanningAuthorityDevices() {
  registerScanningAuthorityDeviceCredential();
  registerScanningAuthorityDeviceAdmin();
}
