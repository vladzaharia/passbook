import { beforeAll, describe, vi } from 'vitest';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
import { registerAuthorityHistory } from './repo-act-authority-history-cases-test-fixtures.ts';
import { registerAuthorityIdentity } from './repo-act-authority-identity-cases-test-fixtures.ts';
import { registerAuthorityRetirement } from './repo-act-authority-retirement-cases-test-fixtures.ts';
import { registerAuthoritySessions } from './repo-act-authority-sessions-cases-test-fixtures.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: commit authority', () => {
  registerAuthorityHistory();
  registerAuthorityIdentity();
  registerAuthorityRetirement();
  registerAuthoritySessions();
});
