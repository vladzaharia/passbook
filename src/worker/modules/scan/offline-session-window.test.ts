import { describe, expect, it } from 'vitest';
import { sessionAcceptsAt } from './batch.ts';
import type { ScanActor } from './guard.ts';

const actor = (status: 'active' | 'paused' | 'ended', whenOffline: 'list' | 'stop') =>
  ({
    scanningSession: { id: 's', status, updatedAt: 1000 },
    settings: { offline: whenOffline === 'list', whenOffline },
  }) as unknown as ScanActor;

describe('a queued read against the session it syncs into', () => {
  it('keeps reads taken before a pause, an end or Stop, and refuses those after', () => {
    for (const a of [actor('paused', 'list'), actor('ended', 'list'), actor('active', 'stop')]) {
      expect(sessionAcceptsAt(a, 500)).toBe(true);
      expect(sessionAcceptsAt(a, 1500)).toBe(false);
    }
  });

  it('takes any read of a live session', () => {
    expect(sessionAcceptsAt(actor('active', 'list'), 5000)).toBe(true);
  });
});
