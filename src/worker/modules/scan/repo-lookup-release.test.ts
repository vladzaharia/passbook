import { describe } from 'vitest';
import { registerLookupReleasePrivacyCases } from './repo-lookup-release-privacy-test-fixtures.ts';
import {
  registerLookupLegacyReleaseCases,
  registerLookupReleaseScopedCases,
} from './repo-lookup-release-scope-test-fixtures.ts';
import { registerLookupReleaseSnapshotCases } from './repo-lookup-release-snapshot-test-fixtures.ts';
import { registerLookupReleaseFixture } from './repo-lookup-release-test-fixtures.ts';
import { registerLookupWalletProvenanceCases } from './repo-lookup-release-wallet-provenance-test-fixtures.ts';
import {
  registerLookupPartialReleaseCases,
  registerLookupWalletCases,
} from './repo-lookup-release-wallet-test-fixtures.ts';

registerLookupReleaseFixture();

describe('scanner candidate release snapshots', () => {
  registerLookupReleaseSnapshotCases();
  registerLookupReleaseScopedCases();
  registerLookupPartialReleaseCases();
  registerLookupLegacyReleaseCases();
  registerLookupWalletCases();
  registerLookupWalletProvenanceCases();
  registerLookupReleasePrivacyCases();
});
