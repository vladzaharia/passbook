import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { markSeen, useSeenMarks } from './attention.ts';
import { setPerson } from './person.ts';
import { setSingleKeys, singleKeysOn } from './prefs.ts';

afterEach(() => {
  setPerson(undefined);
  localStorage.clear();
});

describe('per-person browser state (R4 L7)', () => {
  it("the single-key switch is one person's, not the browser's", () => {
    setPerson('u1');
    setSingleKeys(false);
    expect(singleKeysOn()).toBe(false);
    setPerson('u2');
    expect(singleKeysOn()).toBe(true);
    setPerson('u1');
    expect(singleKeysOn()).toBe(false);
  });

  it("seen marks are one person's too", () => {
    setPerson('u1');
    markSeen('org_1', 'logs', 500);
    expect(renderHook(() => useSeenMarks('org_1')).result.current).toEqual({ logs: 500 });
    setPerson('u2');
    expect(renderHook(() => useSeenMarks('org_1')).result.current).toEqual({});
  });
});
