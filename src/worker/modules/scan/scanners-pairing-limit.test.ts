import { describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/index.ts';
import { env, pairCall, setupScannerFixture } from './scanners-split-test-fixtures.ts';

setupScannerFixture();

describe('pairing rate limit', () => {
  it('refuses with 429 once the per-IP budget is spent, before looking at the code', async () => {
    Object.assign(env, { RL_SCAN_PAIR: fakeRateLimiter({ limit: 2 }) });
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).not.toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).not.toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).toBe(429);
    expect((await pairCall('', 'AAAAABBBBB')).status).toBe(429);
  });
});
