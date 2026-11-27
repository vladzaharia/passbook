import { safeNextPath } from '@/shared/next.ts';
import { decodeHash, encodeHash, type PlaygroundState } from '../../playground/hash.ts';
import { DEFAULT_BLUEPRINT } from '../../playground/model.ts';
import { readMirror, writeMirror } from './use-anon-state.ts';

/** The path of the signed-out Design page, and of the hand-off that continues it signed in. */
export const ANON_PATH = '/workbench/design';

/** `s=<code>` in the hash: the person asked to save this design to their sandbox; the code is this tab's. */
const FLAG = 's';
const CODE_KEY = 'wb-anon-handoff';

const paramsOf = (hash: string) => new URLSearchParams(hash.replace(/^#/, ''));

export const handoffCode = (hash: string): string => paramsOf(hash).get(FLAG) ?? '';

export const isHandoffHash = (hash: string): boolean => handoffCode(hash) !== '';

const flagged = (state: PlaygroundState, code: string): string =>
  `${encodeHash(state)}&${FLAG}=${code}`;

/**
 * True when this tab pressed Save and the link carries its code, so the save runs unasked. A link
 * from anywhere else, a reused one or one with no code only asks first (the review step).
 */
export function ownsHandoff(hash: string): boolean {
  const code = handoffCode(hash);
  try {
    return code !== '' && sessionStorage.getItem(CODE_KEY) === code;
  } catch {
    // Storage blocked: the person reviews and presses Save.
    return false;
  }
}

/** The one-time code is spent when the save is done. */
export function spendHandoff(): void {
  try {
    sessionStorage.removeItem(CODE_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
/**
 * Where "Save to my sandbox" goes: the same page with the flag, after sign-in when needed. A `next`
 * is a short path, so edits ride in it only while they fit; the tab's kept state holds the rest.
 */
export function handoffTarget(state: PlaygroundState): string {
  writeMirror(state);
  const code = crypto.randomUUID().replaceAll('-', '');
  try {
    sessionStorage.setItem(CODE_KEY, code);
  } catch {
    // Storage blocked: the link will ask before it saves.
  }
  const full = `${ANON_PATH}${flagged(state, code)}`;
  return safeNextPath(full) ? full : `${ANON_PATH}${flagged({ ...state, edits: {} }, code)}`;
}

/** What the signed-in side saves: the hash's blueprint, with the tab's kept edits when this tab's own hand-off lost them. */
export function handoffState(hash: string): PlaygroundState {
  const state = decodeHash(hash, DEFAULT_BLUEPRINT);
  const kept = readMirror();
  if (ownsHandoff(hash) && !paramsOf(hash).has('i') && kept && kept.template === state.template)
    return { ...state, edits: kept.edits };
  return state;
}

/** A link that names a blueprint (a shared one, or a hand-off): the sandbox offers to save it. */
export const namesBlueprint = (hash: string): boolean =>
  paramsOf(hash).has('t') || isHandoffHash(hash);
