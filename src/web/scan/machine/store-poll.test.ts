import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanCounts } from '../../../shared/contracts/scan.ts';
import { ScanApiError } from '../api/errors.ts';
import { toFail } from '../api/to-fail.ts';
import { SCAN_TIMING } from '../timing.ts';
import { states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(resetIds);

const COUNTS: ScanCounts = { today: 4, event: null, asOf: 1, configRev: 1 };

function boot(stats: () => Promise<ScanCounts>) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const statsFn = vi.fn(stats);
  const deps = {
    ...fake.deps,
    api: { ...fake.api, stats: statsFn },
    toFail: (e: unknown) => toFail(e),
  };
  const store = createScanStore(deps, states.ready());
  return { clock, store, stats: statsFn, deps };
}

const refused = (status: number, code: string) => () =>
  Promise.reject(new ScanApiError({ status, code }));

describe('scan store counts poll', () => {
  it.each([['SCAN_CONFIG_CHANGED'], ['SCAN_STAFF_CHANGED']])(
    'a 409 %s never blocks the door and the poll tries again later',
    async (code) => {
      const { clock, store, stats, deps } = boot(refused(409, code));
      clock.advance(SCAN_TIMING.COUNTS_POLL);
      await flush();
      expect(stats).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().state.block).toBeNull();
      expect(deps.wipe).not.toHaveBeenCalled();
      stats.mockImplementation(async () => COUNTS);
      clock.advance(SCAN_TIMING.COUNTS_POLL);
      await flush();
      expect(stats).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot().state.counts).toEqual(COUNTS);
      expect(store.getSnapshot().state.block).toBeNull();
    },
  );

  it('a 401 SCANNER_REPAIR (credential gone) blocks and wipes, as the control', async () => {
    const { clock, store, stats, deps } = boot(refused(401, 'SCANNER_REPAIR'));
    clock.advance(SCAN_TIMING.COUNTS_POLL);
    await flush();
    expect(stats).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state.block).toBe('revoked');
    expect(deps.wipe).toHaveBeenCalledTimes(1);
    clock.advance(SCAN_TIMING.COUNTS_POLL * 2);
    expect(stats).toHaveBeenCalledTimes(1);
  });
});
