import { beforeEach, describe, expect, it } from 'vitest';
import { safeNextPath } from '@/shared/next.ts';
import { DEFAULTS, encodeHash, type PlaygroundState } from '../../playground/hash.ts';
import { ANON_PATH, handoffState, handoffTarget, isHandoffHash } from './handoff.ts';
import { clearMirror, readMirror } from './use-anon-state.ts';

const STORE = 'baked:starter-store-card';
const state = (edits: PlaygroundState['edits']): PlaygroundState => ({
  template: STORE,
  edits,
  ...DEFAULTS,
});

beforeEach(() => sessionStorage.clear());

describe('the hand-off from the signed-out page', () => {
  it('flags the hash and keeps a short link as a safe next path', () => {
    const target = handoffTarget(state({ holder: 'Ada' }));
    expect(target.startsWith(`${ANON_PATH}#`)).toBe(true);
    expect(isHandoffHash(target.slice(target.indexOf('#')))).toBe(true);
    expect(safeNextPath(target)).toBe(target);
    expect(handoffState(target.slice(target.indexOf('#'))).edits).toEqual({ holder: 'Ada' });
  });

  it('drops edits from a link too long for next, and the tab’s kept state brings them back', () => {
    const edits = { holder: 'x'.repeat(900) };
    const target = handoffTarget(state(edits));
    expect(safeNextPath(target)).toBe(target);
    expect(target).not.toContain('i=');
    expect(handoffState(target.slice(target.indexOf('#'))).edits).toEqual(edits);
  });

  it('does not lend another blueprint’s edits to a link', () => {
    handoffTarget(state({ holder: 'Ada' }));
    expect(handoffState(`#t=${encodeURIComponent('baked:other')}&s=1`).edits).toEqual({});
  });

  it('leaves the flag off an ordinary link, and clears what it kept', () => {
    expect(isHandoffHash(encodeHash(state({})))).toBe(false);
    handoffTarget(state({ holder: 'Ada' }));
    expect(readMirror()?.edits).toEqual({ holder: 'Ada' });
    clearMirror();
    expect(readMirror()).toBeNull();
  });
});
