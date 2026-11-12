import { beforeAll, describe } from 'vitest';
import { registerScanningAuthorityReleases } from './repo-scanning-authority-releases-test-fixtures.ts';
import { registerScanningAuthorityScope } from './repo-scanning-authority-scope-test-fixtures.ts';
import { registerScanningAuthorityAdmin } from './scanning-authority-admin-test-fixtures.ts';
import { registerScanningAuthorityDevices } from './scanning-authority-devices-test-fixtures.ts';
import { setupScanningAuthorityFixture } from './scanning-authority-test-fixtures.ts';

beforeAll(setupScanningAuthorityFixture);

describe('scanner configuration authority', () => {
  registerScanningAuthorityScope();
  registerScanningAuthorityReleases();
  registerScanningAuthorityAdmin();
  registerScanningAuthorityDevices();
});
