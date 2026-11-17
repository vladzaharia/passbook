import { beforeAll, describe, vi } from 'vitest';
import { registerRoundTrips } from './act-round-trips-cases-test-fixtures.ts';
import { setupActionFixture } from './act-test-fixtures.ts';
import type * as LiveModule from './live.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

beforeAll(setupActionFixture);

describe('act: round trips (SA 13.1)', () => {
  registerRoundTrips();
});
