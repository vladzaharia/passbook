import { describe, expect, it } from 'vitest';
import { checkJourney, stepStem } from '../lib/journey.ts';
import { journeys } from './index.ts';

describe('visual journeys', () => {
  it('registers the eight verticals once each, in plan order', () => {
    expect(journeys.map((j) => j.name)).toEqual([
      'pass-lifecycle',
      'join',
      'import',
      'connections-webhooks',
      'messages',
      'onboarding-signin',
      'retention',
      'bundles',
    ]);
  });

  it('every journey is runnable and its steps sort in the order a user sees them', () => {
    for (const journey of journeys) {
      expect(() => checkJourney(journey)).not.toThrow();
      const stems = journey.steps.map((s, i) => stepStem(i, s.title));
      expect(new Set(stems).size).toBe(stems.length);
      if (journey.steps.length < 100) expect([...stems].sort()).toEqual(stems);
    }
  });
});
