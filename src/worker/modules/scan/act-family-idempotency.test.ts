import { beforeAll, describe, vi } from 'vitest';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
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
