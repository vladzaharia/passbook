import { Fragment, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { isApiError } from '../lib/errors.ts';
import { lookAt } from '../lib/gaze.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { HOURGLASS } from '../ui/art/wallet-states.tsx';
import { useScene, WalletArt } from '../ui/index.ts';
import './login-scene.css';

/**
 * What the wallet is doing: cards fanned (rest), the top card posted into the sign-in card
 * (sent), the card back after "Use a different email" (back), or the fan tucked in (success).
 */
export type SceneBeat = 'rest' | 'sent' | 'back' | 'success';

/**
 * Why the wallet is down, until the holder types again or the beat moves on. load: the page
 * arrived with a failure; error: an attempt failed (network, server); slip: a wrong code or address
 * (flat, one shake); wait: a rate limit (the hourglass flips in); expired: the code ran out (the
 * gold pass greys and droops). All but slip are sad.
 */
export type SceneSad = 'load' | 'error' | 'slip' | 'wait' | 'expired' | null;
export type SceneFail = Exclude<SceneSad, 'load' | null>;

export interface SceneState {
  beat: SceneBeat;
  /** First letter of a valid address: the top card lifts and shows it. */
  letter: string | null;
  /** Bumped per slip: one shake. */
  shake: number;
  sad: SceneSad;
  /** Bumped per rate limit: the hourglass flips in again. */
  waits: number;
  /** The scene root, for gaze (set per keystroke without a render). */
  root: RefObject<HTMLDivElement | null>;
}

export interface SceneActions {
  setLetter: (letter: string | null) => void;
  send: () => void;
  back: () => void;
  fail: (why: SceneFail) => void;
  succeed: () => void;
  /** The eyes follow typing: the caret's viewport x; null (blur) or 1.5 s idle lets go. */
  gaze: (x: number | null) => void;
}

/** A failed request: a rate limit waits, refused input slips, anything else is an error. */
export function failure(error: unknown): SceneFail {
  if (!isApiError(error)) return 'error';
  if (error.status === 429) return 'wait';
  return error.status === 400 || error.status === 422 ? 'slip' : 'error';
}

const GAZE_HOLD_MS = 1500;

export { lookAt } from '../lib/gaze.ts';

/** Scene state for the sign-in page; the card drives it through the actions. */
export function useLoginScene(sadOnLoad = false): [SceneState, SceneActions] {
  const root = useRef<HTMLDivElement>(null);
  const gazeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(gazeTimer.current), []);
  const [state, setState] = useState<SceneState>({
    beat: 'rest',
    letter: null,
    shake: 0,
    sad: sadOnLoad ? 'load' : null,
    waits: 0,
    root,
  });
  const actions = useMemo<SceneActions>(
    () => ({
      setLetter: (letter) => setState((s) => (s.letter === letter ? s : { ...s, letter })),
      send: () => setState((s) => ({ ...s, beat: 'sent', sad: null })),
      back: () => setState((s) => ({ ...s, beat: 'back', sad: null })),
      fail: (why) =>
        setState((s) => ({
          ...s,
          sad: why,
          shake: why === 'slip' ? s.shake + 1 : s.shake,
          waits: why === 'wait' ? s.waits + 1 : s.waits,
        })),
      succeed: () => setState((s) => ({ ...s, beat: 'success', sad: null })),
      gaze: (x) => {
        const el = root.current;
        clearTimeout(gazeTimer.current);
        // Typing again cheers it up.
        if (x !== null) setState((s) => (s.sad ? { ...s, sad: null } : s));
        if (!el) return;
        el.toggleAttribute('data-gaze', x !== null);
        if (x === null) return;
        // The wallet sits at the card's right, so most of the field is to its left.
        el.style.setProperty('--gx', lookAt(x, el.getBoundingClientRect()).toFixed(3));
        // A pause in typing hands the eyes back to the pointer.
        gazeTimer.current = setTimeout(() => el.removeAttribute('data-gaze'), GAZE_HOLD_MS);
      },
    }),
    [],
  );
  return [state, actions];
}

const FINE = '(hover: hover) and (pointer: fine)';
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Pauses the scene while the tab is hidden (data-paused stops every animation, so the entrance
 * and the one idle beat play when the holder is looking) and, on fine pointers, leans the wallet
 * toward the pointer: --px and --py in -1…1, one rAF-throttled listener, off while hidden.
 */
function useScenePointer(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fine =
      typeof matchMedia === 'function' && matchMedia(FINE).matches && !prefersReducedMotion();
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect();
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        const x = clamp((e.clientX - (box.left + box.width / 2)) / Math.max(innerWidth / 3, 1));
        const y = clamp((e.clientY - (box.top + box.height / 2)) / Math.max(innerHeight / 3, 1));
        el.style.setProperty('--px', x.toFixed(3));
        el.style.setProperty('--py', y.toFixed(3));
      });
    };
    const listen = (on: boolean) => {
      if (!fine) return;
      if (on) window.addEventListener('pointermove', move, { passive: true });
      else window.removeEventListener('pointermove', move);
    };
    const sync = () => {
      const off = hidden();
      el.toggleAttribute('data-paused', off);
      listen(!off);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', sync);
      listen(false);
    };
  }, [ref]);
}

/** Restarts a one-shot animation keyed on data-<name> whenever `count` grows. */
function useOneShot(ref: { current: HTMLElement | null }, name: string, count: number) {
  useEffect(() => {
    const el = ref.current;
    if (!el || count === 0) return;
    el.removeAttribute(`data-${name}`);
    void el.offsetWidth;
    el.setAttribute(`data-${name}`, '');
    const done = (e: AnimationEvent) => {
      if (e.target === el) el.removeAttribute(`data-${name}`);
    };
    el.addEventListener('animationend', done);
    return () => el.removeEventListener('animationend', done);
  }, [ref, name, count]);
}

/**
 * "The wallet fills" (motion-and-expression.md, moment 8): the mascot sits on the sign-in card's
 * top edge, legs over it, three passes fanned. Decorative: aria-hidden, no words; every beat is
 * CSS on transform and opacity (login-scene.css); the state parts are the SSR band's
 * (art/wallet-states.tsx). `sad` is a failure the page shows on its own; `bye` (just signed out)
 * waves the top card once after the entrance.
 */
export function LoginScene({
  state,
  sad,
  bye,
  className,
}: {
  state: SceneState;
  sad?: boolean;
  bye?: boolean;
  className?: string;
}) {
  const root = state.root;
  const pocket = useRef<HTMLSpanElement>(null);
  // A click waves hello at rest (art/scenes/common.css).
  const { ref: hello } = useScene<HTMLSpanElement>(false);
  useScenePointer(root);
  useOneShot(pocket, 'shake', state.shake);
  const why = state.sad ?? (sad ? 'load' : null);
  const resting = state.beat === 'rest' || state.beat === 'back';
  // Reduced motion: the letter shows in place, the card never lifts.
  const lift = Boolean(state.letter) && resting && !why && !prefersReducedMotion();
  const mood =
    state.beat === 'success' ? 'happy' : why === 'slip' ? 'flat' : why ? 'sad' : undefined;
  return (
    <div
      ref={root}
      className={cn('wl-login-scene', className)}
      data-beat={state.beat === 'rest' ? undefined : state.beat}
      data-sad={why ?? undefined}
      data-bye={bye || undefined}
      aria-hidden
    >
      <span ref={hello} className="wl-login-lean" data-replay="" data-scene="hello">
        <span ref={pocket} className="wl-login-pocket">
          <WalletArt
            state={why === 'expired' ? 'expired' : 'login'}
            size="xl"
            seat
            lift={lift}
            {...(mood ? { mood } : {})}
            onCard={
              state.letter ? (
                <text key={state.letter} className="wl-login-initial" x="48" y="23">
                  {state.letter}
                </text>
              ) : null
            }
            front={SLOT}
            aside={why === 'wait' ? <Fragment key={state.waits}>{HOURGLASS}</Fragment> : null}
          />
        </span>
      </span>
    </div>
  );
}

/** The card's top edge is a letterbox: the fan is clipped there, so a posted pass drops in. */
const SLOT = (
  <defs>
    <clipPath id="wl-login-slot">
      <rect x="-60" y="-60" width="216" height="126" />
    </clipPath>
  </defs>
);
