import { safeNextPath } from '@/shared/next.ts';
import { decodeHash, encodeHash, type PlaygroundState } from '../../playground/hash.ts';
import { DEFAULT_BLUEPRINT } from '../../playground/model.ts';
import { readMirror, writeMirror } from './use-anon-state.ts';

/** The path of the signed-out Design page, and of the hand-off that continues it signed in. */
export const ANON_PATH = '/workbench/design';

/** `s=1` in the hash: the person asked to save this design to their sandbox. */
const FLAG = 's';

const paramsOf = (hash: string) => new URLSearchParams(hash.replace(/^#/, ''));

export const isHandoffHash = (hash: string): boolean => paramsOf(hash).get(FLAG) === '1';

const flagged = (state: PlaygroundState): string => `${encodeHash(state)}&${FLAG}=1`;

/**
 * Where "Save to my sandbox" goes: the same page with the flag, after sign-in when needed. A `next`
 * is a short path, so edits ride in it only while they fit; the tab's kept state holds the rest.
 */
export function handoffTarget(state: PlaygroundState): string {
  writeMirror(state);
  const full = `${ANON_PATH}${flagged(state)}`;
  return safeNextPath(full) ? full : `${ANON_PATH}${flagged({ ...state, edits: {} })}`;
}

/** What the signed-in side saves: the hash's blueprint, with the tab's kept edits when the hash lost them. */
export function handoffState(hash: string): PlaygroundState {
  const state = decodeHash(hash, DEFAULT_BLUEPRINT);
  const kept = readMirror();
  if (!paramsOf(hash).has('i') && kept && kept.template === state.template)
    return { ...state, edits: kept.edits };
  return state;
}
