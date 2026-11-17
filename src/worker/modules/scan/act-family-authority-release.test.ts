import { beforeAll, describe, vi } from 'vitest';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
import { registerAuthorityGates } from './repo-act-authority-gates-cases-test-fixtures.ts';
import { registerAuthorityRelease } from './repo-act-authority-release-cases-test-fixtures.ts';
import { registerAuthorityScreens } from './repo-act-authority-screens-cases-test-fixtures.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: commit authority', () => {
  registerAuthorityRelease();
  registerAuthorityScreens();
  registerAuthorityGates();
});
