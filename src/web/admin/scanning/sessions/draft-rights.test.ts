import { describe, expect, it } from 'vitest';
import { settingsOf } from '../scanners/scanner-draft.ts';
import { emptySessionDraft, sessionBody, sessionDraft } from './draft.ts';
import { managedSession } from './test-fixtures.ts';

describe('Approvals and Hard limit in the session draft', () => {
  it('default to Managers and off', () => {
    const d = emptySessionDraft();
    expect(d).toMatchObject({ approvals: 'managers', hardLimit: false });
    expect(settingsOf(d)).toMatchObject({ approvals: 'managers', hardLimit: false });
  });

  it('round-trip a saved session, so Off and Managers stick', () => {
    const saved = {
      ...managedSession,
      settings: { ...managedSession.settings, approvals: 'desk' as const, hardLimit: true },
    };
    const d = sessionDraft(saved);
    expect(d).toMatchObject({ approvals: 'desk', hardLimit: true });
    expect(sessionBody(d).settings).toMatchObject({ approvals: 'desk', hardLimit: true });
    expect(sessionBody({ ...d, approvals: 'managers', hardLimit: false }).settings).toMatchObject({
      approvals: 'managers',
      hardLimit: false,
    });
  });
});
