import { beforeAll, describe, vi } from 'vitest';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';
import { registerFailures } from './repo-act-failures-cases-test-fixtures.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: bodies and failures', () => {
  registerFailures();
});
