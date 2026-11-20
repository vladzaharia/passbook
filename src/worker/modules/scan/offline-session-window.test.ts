import { describe, expect, it } from 'vitest';
import { sessionAcceptsAt } from './batch.ts';
import type { ScanActor } from './guard.ts';

const actor = (status: 'active' | 'paused' | 'ended', whenOffline: 'list' | 'stop' = 'list') =>
  ({
    scanningSession: { id: 's', status, updatedAt: 5000 },
    settings: { offline: whenOffline === 'list', whenOffline },
  }) as unknown as ScanActor;

const paused = {
  at: 1000,
  status: 'paused',
  mode: 'list',
  prev_status: 'active',
  prev_mode: 'list',
  timing: null,
  prev_timing: null,
};

describe('a queued read against the session it syncs into', () => {
  it('judges a read by the state in force when it was taken', () => {
    expect(sessionAcceptsAt(actor('paused'), 500, [paused])).toBe(true);
    expect(sessionAcceptsAt(actor('paused'), 1500, [paused])).toBe(false);
  });

  it('an unrelated edit while paused does not admit reads taken after the pause', () => {
    // updatedAt is 5000 (a note edited later): the pause at 1000 still stands.
    expect(sessionAcceptsAt(actor('paused'), 3000, [paused])).toBe(false);
  });

  it('Stop recorded in history refuses later reads and keeps earlier ones', () => {
    const stop = {
      at: 1000,
      status: 'active',
      mode: 'stop',
      prev_status: 'active',
      prev_mode: 'list',
      timing: null,
      prev_timing: null,
    };
    expect(sessionAcceptsAt(actor('active', 'stop'), 500, [stop])).toBe(true);
    expect(sessionAcceptsAt(actor('active', 'stop'), 1500, [stop])).toBe(false);
  });

  it('a read dated before the last clean online contact is backdated', () => {
    expect(sessionAcceptsAt(actor('active'), 10_000, [], 100_000)).toBe(false);
    expect(sessionAcceptsAt(actor('active'), 100_000, [], 100_000)).toBe(true);
  });

  it("judges hours and holds by the timing in force then, not the session's current ones", () => {
    const closed = JSON.stringify({
      hours: null,
      hold: '{"state":"closed","until":9000}',
      timeZone: 'UTC',
    });
    const open = JSON.stringify({ hours: null, hold: null, timeZone: 'UTC' });
    const closedAt1000 = {
      at: 1000,
      status: 'active',
      mode: 'list',
      prev_status: 'active',
      prev_mode: 'list',
      timing: closed,
      prev_timing: open,
    };
    expect(sessionAcceptsAt(actor('active'), 500, [closedAt1000])).toBe(true);
    expect(sessionAcceptsAt(actor('active'), 1500, [closedAt1000])).toBe(false);
    // The hold ended on its own at 9000.
    expect(sessionAcceptsAt(actor('active'), 9500, [closedAt1000])).toBe(true);
  });

  it('takes any read of a live session with no history', () => {
    expect(sessionAcceptsAt(actor('active'), 5000, [])).toBe(true);
  });
});
