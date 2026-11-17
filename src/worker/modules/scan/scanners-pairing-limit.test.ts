import { describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/index.ts';
import { device, env, pairCall, setupScannerFixture } from './scanners-split-test-fixtures.ts';

setupScannerFixture();

describe('pairing rate limit', () => {
  it('refuses with 429 once the per-IP budget is spent, before looking at the code', async () => {
    Object.assign(env, { RL_SCAN_PAIR: fakeRateLimiter({ limit: 2 }) });
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).not.toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).not.toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB')).status).toBe(429);
    expect((await pairCall('', 'AAAAABBBBB')).status).toBe(429);
  });

  it('counts a whole /24 as one source: a guesser cannot spread over its addresses', async () => {
    Object.assign(env, { RL_SCAN_PAIR: fakeRateLimiter({ limit: 1 }) });
    const from = (ip: string) => ({ ...device(), 'cf-connecting-ip': ip });
    expect((await pairCall('/preview', 'AAAAABBBBB', from('198.51.100.1'))).status).not.toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB', from('198.51.100.200'))).status).toBe(429);
    expect((await pairCall('/preview', 'AAAAABBBBB', from('198.51.101.1'))).status).not.toBe(429);
  });
});
