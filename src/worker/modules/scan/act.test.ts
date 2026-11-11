import { beforeAll, describe, vi } from 'vitest';
import { registerRoundTrips } from './act-round-trips-cases-test-fixtures.ts';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
import { registerAuthorityCredentials } from './repo-act-authority-credentials-cases-test-fixtures.ts';
import { registerAuthorityGates } from './repo-act-authority-gates-cases-test-fixtures.ts';
import { registerAuthorityGrants } from './repo-act-authority-grants-cases-test-fixtures.ts';
import { registerAuthorityHistory } from './repo-act-authority-history-cases-test-fixtures.ts';
import { registerAuthorityIdentity } from './repo-act-authority-identity-cases-test-fixtures.ts';
import { registerAuthorityMisses } from './repo-act-authority-misses-cases-test-fixtures.ts';
import { registerAuthorityRelease } from './repo-act-authority-release-cases-test-fixtures.ts';
import { registerAuthorityRetirement } from './repo-act-authority-retirement-cases-test-fixtures.ts';
import { registerAuthorityScreens } from './repo-act-authority-screens-cases-test-fixtures.ts';
import { registerAuthoritySessions } from './repo-act-authority-sessions-cases-test-fixtures.ts';
import { registerCheckIn } from './repo-act-check-in-cases-test-fixtures.ts';
import { registerConcurrency } from './repo-act-concurrency-cases-test-fixtures.ts';
import { registerFailures } from './repo-act-failures-cases-test-fixtures.ts';
import { registerGates } from './repo-act-gates-cases-test-fixtures.ts';
import { registerOverrides } from './repo-act-overrides-cases-test-fixtures.ts';
import { registerReads } from './repo-act-reads-cases-test-fixtures.ts';
import { registerRecovery } from './repo-act-recovery-cases-test-fixtures.ts';
import { registerRecoveryRaces } from './repo-act-recovery-races-cases-test-fixtures.ts';
import { registerReplayEligibility } from './repo-act-replay-eligibility-cases-test-fixtures.ts';
import { registerReplayFingerprint } from './repo-act-replay-fingerprint-cases-test-fixtures.ts';
import { registerReplayProjection } from './repo-act-replay-projection-cases-test-fixtures.ts';
import { registerReplayProof } from './repo-act-replay-proof-cases-test-fixtures.ts';
import { registerReplayProvenance } from './repo-act-replay-provenance-cases-test-fixtures.ts';
import { registerReplayReceipts } from './repo-act-replay-receipts-cases-test-fixtures.ts';
import { registerReplayScope } from './repo-act-replay-scope-cases-test-fixtures.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: check-in', () => {
  registerCheckIn();
});

describe('act: idempotency', () => {
  registerReplayProof();
  registerReplayFingerprint();
  registerReplayReceipts();
  registerReplayEligibility();
  registerReplayProjection();
  registerReplayScope();
  registerReplayProvenance();
  registerRecovery();
  registerRecoveryRaces();
});

describe('act: concurrency', () => {
  registerConcurrency();
});

describe('act: commit authority', () => {
  registerAuthorityGrants();
  registerAuthorityCredentials();
  registerAuthorityMisses();
  registerAuthorityRelease();
  registerAuthorityScreens();
  registerAuthorityGates();
  registerAuthorityHistory();
  registerAuthorityIdentity();
  registerAuthorityRetirement();
  registerAuthoritySessions();
});

describe('act: gates', () => {
  registerGates();
});

describe('act: letInAgain and overrides', () => {
  registerOverrides();
});

describe('act: bodies and failures', () => {
  registerFailures();
});

describe('act: round trips (SA 13.1)', () => {
  registerRoundTrips();
});

describe('reads', () => {
  registerReads();
});
