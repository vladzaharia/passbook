import { describe, expect, it } from 'vitest';
import { sessionAccepts, sessionBody, sessionDraft, sessionReady } from './draft.ts';
import { managedSession } from './test-fixtures.ts';

const E1 = '01900000-0000-7000-8000-0000000000e1';
const E2 = '01900000-0000-7000-8000-0000000000e2';
const T1 = '01900000-0000-7000-8000-0000000000a1';

describe('a session that admits events beside templates', () => {
  it('keeps its events when saved from this editor', () => {
    const mixed = { ...managedSession, accepts: { templateIds: [T1], eventIds: [E1] } };
    const d = sessionDraft(mixed);
    expect(d).toMatchObject({ accepts: 'templates', templateIds: [T1] });
    expect(sessionBody(d).accepts).toEqual({ templateIds: [T1], eventIds: [E1] });
    expect(sessionAccepts(mixed)).toBe('1 pass type, 1 event');
  });

  it('saves a session of events only', () => {
    const d = sessionDraft({ ...managedSession, accepts: { templateIds: [], eventIds: [E1, E2] } });
    expect(sessionReady(d)).toBe(true);
    expect(sessionBody(d).accepts).toEqual({ templateIds: [], eventIds: [E1, E2] });
  });

  it('sends the older form for a single shape', () => {
    const d = sessionDraft({ ...managedSession, accepts: { templateIds: [T1] } });
    expect(sessionBody(d).accepts).toEqual({ templateIds: [T1] });
  });
});

describe('the editor round trip', () => {
  const ids = (n: number, p: string) =>
    Array.from(
      { length: n },
      (_, i) => `01900000-0000-7000-8000-${p}${String(i).padStart(11, '0')}`,
    );

  it('carries 100 pass types and 10 events through the draft unchanged', () => {
    const accepts = { templateIds: ids(100, 'a'), eventIds: ids(10, 'e') };
    const d = sessionDraft({ ...managedSession, accepts });
    expect(sessionBody(d).accepts).toEqual(accepts);
    expect(sessionAccepts({ ...managedSession, accepts })).toBe('100 pass types, 10 events');
  });

  it('reads the older one-event form as an event entry', () => {
    const d = sessionDraft({ ...managedSession, accepts: { eventId: E1 } });
    expect(d).toMatchObject({ templateIds: [], eventIds: [E1] });
    expect(sessionBody(d).accepts).toEqual({ eventId: E1 });
  });

  it('holds no zones on events only, and keeps them on a mix', () => {
    const only = sessionDraft({ ...managedSession, accepts: { eventId: E1 }, zoneIds: ['z1'] });
    expect(sessionBody(only).zoneIds).toEqual([]);
    const mixed = sessionDraft({
      ...managedSession,
      accepts: { templateIds: [T1], eventIds: [E1] },
      zoneIds: ['z1'],
    });
    expect(sessionBody(mixed).zoneIds).toEqual(['z1']);
  });

  it('is not ready with nothing admitted, and Any needs no list', () => {
    const d = sessionDraft({ ...managedSession, accepts: { templateIds: [T1] } });
    expect(sessionReady({ ...d, templateIds: [] })).toBe(false);
    expect(sessionBody({ ...d, accepts: 'all', templateIds: [] }).accepts).toBeNull();
    expect(sessionReady({ ...d, accepts: 'all', templateIds: [] })).toBe(true);
  });
});
