/* istanbul ignore file -- @preserve */
import { registerScanningAuthorityAdminMembership } from './repo-scanning-authority-admin-membership-test-fixtures.ts';
import { registerScanningAuthorityAdminSession } from './repo-scanning-authority-admin-session-test-fixtures.ts';

export function registerScanningAuthorityAdmin() {
  registerScanningAuthorityAdminSession();
  registerScanningAuthorityAdminMembership();
}
