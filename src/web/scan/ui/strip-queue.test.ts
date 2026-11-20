import { describe, expect, it } from 'vitest';
import { dockStrip } from './strip-of.ts';

const state = (over: object = {}) => ({
  online: false,
  queue: { pending: 3, oldestAt: 1, conflicts: 0 },
  unsure: [],
  offline: { mode: 'list' as const, listAt: Date.parse('2026-11-20T19:36:00'), syncing: false },
  ...over,
});
const since = Date.parse('2026-11-20T19:38:00');

describe('the offline queue line on a handheld', () => {
  it('reads the count, since when and the list age, with View', () => {
    const e = dockStrip(state(), undefined, false, 0, { since });
    expect(e).toMatchObject({ title: '3 waiting to sync', view: true, icon: 'offline' });
    expect(e?.meta).toMatch(/^Offline since .*7:38.* · list from .*7:36/);
  });
  it('leaves the list out when the door is not on a list', () => {
    const e = dockStrip(
      state({ offline: { mode: 'decide', listAt: null, syncing: false } }),
      undefined,
      false,
      0,
      { since },
    );
    expect(e?.meta).toMatch(/^Offline since [^·]*$/);
  });
  it('is the old strip on a tablet, and with nothing saved', () => {
    expect(dockStrip(state(), undefined, false, 0)?.view).toBeUndefined();
    expect(
      dockStrip(
        state({ queue: { pending: 0, oldestAt: null, conflicts: 0 } }),
        undefined,
        false,
        0,
        { since },
      )?.view,
    ).toBeUndefined();
  });
  it('is the last scan when online', () => {
    expect(dockStrip(state({ online: true }), undefined, false, 0, { since })).toBeNull();
  });
});
