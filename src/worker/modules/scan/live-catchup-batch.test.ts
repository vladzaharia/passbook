import { describe } from 'vitest';
import { registerCatchupDamageTests } from './repo-live-catchup-batch-damage-test-fixtures.ts';
import { registerCatchupIntegrityTests } from './repo-live-catchup-batch-integrity-test-fixtures.ts';
import { registerCatchupRaceTests } from './repo-live-catchup-batch-races-test-fixtures.ts';
import { registerCatchupSessionTests } from './repo-live-catchup-batch-session-test-fixtures.ts';

describe('multirow live catch-up batching', () => {
  registerCatchupIntegrityTests();
  registerCatchupDamageTests();
  registerCatchupRaceTests();
  registerCatchupSessionTests();
});
