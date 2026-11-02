import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { WalletArt } from '../ui/index.ts';
import './login-scene.css';

/**
 * What the wallet is doing: cards fanned (rest), the top card posted into the sign-in card
 * (sent), the card back after "Use a different email" (back), or the fan tucked in (success).
 */
export type SceneBeat = 'rest' | 'sent' | 'back' | 'success';

/** Why the wallet is sad: the page arrived with a failure (load) or an attempt failed (fail). */
export type SceneSad = 'load' | 'fail' | null;

export interface SceneState {
  beat: SceneBeat;
  /** First letter of a valid address: the top card lifts and shows it. */
  letter: string | null;
  /** Bumped per wrong code or rate limit: one shake. */
  shake: number;
  /** Sad until the holder types again or the beat moves on. */
  sad: SceneSad;
  /** Bumped when a code turns out to be expired: the hourglass flips. */
  expired: number;
  /** The scene root, for gaze (set per keystroke without a render). */
  root: RefObject<HTMLDivElement | null>;
}

export interface SceneActions {
  setLetter: (letter: string | null) => void;
  send: () => void;
  back: () => void;
  /** Sad; `shake` (default) for a wrong code or rate limit, not for a network or server error. */
  fail: (opts?: { expired?: boolean; shake?: boolean }) => void;
  succeed: () => void;
  /** The eyes follow typing: the caret's viewport x; null (blur) or 1.5 s idle lets go. */
  gaze: (x: number | null) => void;
}

const GAZE_HOLD_MS = 1500;
/** The eyes turn fully toward a caret this far to either side of the wallet's centre. */
const GAZE_REACH = 160;

/** -1…1: how far left or right of the wallet's centre a viewport x is, for the eyes. */
export function lookAt(x: number, scene: { left: number; width: number }): number {
  return Math.min(1, Math.max(-1, (x - (scene.left + scene.width / 2)) / GAZE_REACH));
}

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
    expired: 0,
    root,
  });
  const actions = useMemo<SceneActions>(
    () => ({
      setLetter: (letter) => setState((s) => (s.letter === letter ? s : { ...s, letter })),
      send: () => setState((s) => ({ ...s, beat: 'sent', sad: null })),
      back: () => setState((s) => ({ ...s, beat: 'back', sad: null })),
      fail: (opts) =>
        setState((s) => ({
          ...s,
          sad: 'fail',
          shake: opts?.shake === false ? s.shake : s.shake + 1,
          expired: opts?.expired ? s.expired + 1 : s.expired,
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
 * CSS on transform and opacity (login-scene.css). `sad` is a failure the page shows on its own;
 * `bye` (just signed out) waves the top card once after the entrance.
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
  const hourglass = useRef<HTMLSpanElement>(null);
  useScenePointer(root);
  useOneShot(pocket, 'shake', state.shake);
  useOneShot(hourglass, 'flip', state.expired);
  const why = state.sad ?? (sad ? 'load' : null);
  const resting = state.beat === 'rest' || state.beat === 'back';
  // Reduced motion: the letter shows in place, the card never lifts.
  const lift = Boolean(state.letter) && resting && !why && !prefersReducedMotion();
  const mood = state.beat === 'success' ? 'happy' : why ? 'sad' : undefined;
  return (
    <div
      ref={root}
      className={cn('wl-login-scene', className)}
      data-beat={state.beat === 'rest' ? undefined : state.beat}
      data-sad={why ?? undefined}
      data-bye={bye || undefined}
      aria-hidden
    >
      <span className="wl-login-lean">
        <span ref={pocket} className="wl-login-pocket">
          <WalletArt
            state="login"
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
          />
          <span
            ref={hourglass}
            className="wl-login-hourglass"
            data-on={state.expired ? '' : undefined}
          >
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M7 3h10M7 21h10" />
              <path d="M8 3v3.5L12 12l4-5.5V3M8 21v-3.5L12 12l4 5.5V21" />
              <path className="sand" d="M10 19.5h4l-2-2.8Z" />
            </svg>
          </span>
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
