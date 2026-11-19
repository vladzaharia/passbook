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
    expect(sessionAccepts(mixed)).toBe('1 pass template, 1 event');
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
