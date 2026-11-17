import { beforeAll, describe, vi } from 'vitest';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
import { registerAuthorityCredentials } from './repo-act-authority-credentials-cases-test-fixtures.ts';
import { registerAuthorityGrants } from './repo-act-authority-grants-cases-test-fixtures.ts';
import { registerAuthorityMisses } from './repo-act-authority-misses-cases-test-fixtures.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: commit authority', () => {
  registerAuthorityGrants();
  registerAuthorityCredentials();
  registerAuthorityMisses();
});
