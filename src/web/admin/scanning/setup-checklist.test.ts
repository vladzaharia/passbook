import { describe, expect, it } from 'vitest';
import { setupSteps } from './setup-checklist.tsx';

const done = (c: Partial<Record<'sessions' | 'zones' | 'paired' | 'staff', number>>) =>
  setupSteps({ sessions: 0, zones: 0, paired: 0, staff: 0, ...c }, undefined).map((s) => s.done);

describe('setup checklist', () => {
  it('starts with nothing done', () => {
    expect(done({})).toEqual([false, false, false, false]);
  });
  it('checks each step from its own count', () => {
    expect(done({ sessions: 1, paired: 2 })).toEqual([true, false, true, false]);
    expect(done({ sessions: 1, zones: 1, paired: 1, staff: 1 })).toEqual([true, true, true, true]);
  });
});
