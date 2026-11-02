import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { WalletArt } from '../ui/index.ts';
import './login-scene.css';

/**
 * What the wallet is doing: cards fanned (rest), the top card posted behind the sign-in card
 * (sent), the card back after "Use a different email" (back), or the fan tucked in (success).
 */
export type SceneBeat = 'rest' | 'sent' | 'back' | 'success';

export interface SceneState {
  beat: SceneBeat;
  /** First letter of a valid address: the top card lifts and shows it. */
  letter: string | null;
  /** Bumped per failure: one shake and flat eyes. */
  shake: number;
  /** Bumped when a code turns out to be expired: the hourglass flips. */
  expired: number;
  /** The scene root, for gaze (set per keystroke without a render). */
  root: RefObject<HTMLDivElement | null>;
}

export interface SceneActions {
  setLetter: (letter: string | null) => void;
  send: () => void;
  back: () => void;
  fail: (opts?: { expired?: boolean }) => void;
  succeed: () => void;
  /** The eyes follow typing: 0…1 across the field; null (blur) or 1.5 s idle lets go. */
  gaze: (at: number | null) => void;
}

const GAZE_HOLD_MS = 1500;

/** Scene state for the sign-in page; the card drives it through the actions. */
export function useLoginScene(): [SceneState, SceneActions] {
  const root = useRef<HTMLDivElement>(null);
  const gazeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(gazeTimer.current), []);
  const [state, setState] = useState<SceneState>({
    beat: 'rest',
    letter: null,
    shake: 0,
    expired: 0,
    root,
  });
  const actions = useMemo<SceneActions>(
    () => ({
      setLetter: (letter) => setState((s) => (s.letter === letter ? s : { ...s, letter })),
      send: () => setState((s) => ({ ...s, beat: 'sent' })),
      back: () => setState((s) => ({ ...s, beat: 'back' })),
      fail: (opts) =>
        setState((s) => ({
          ...s,
          shake: s.shake + 1,
          expired: opts?.expired ? s.expired + 1 : s.expired,
        })),
      succeed: () => setState((s) => ({ ...s, beat: 'success' })),
      gaze: (at) => {
        const el = root.current;
        clearTimeout(gazeTimer.current);
        if (!el) return;
        el.toggleAttribute('data-gaze', at !== null);
        if (at === null) return;
        el.style.setProperty('--gx', (Math.min(1, Math.max(0, at)) * 2 - 1).toFixed(3));
        // A pause in typing hands the eyes back to the pointer.
        gazeTimer.current = setTimeout(() => el.removeAttribute('data-gaze'), GAZE_HOLD_MS);
      },
    }),
    [],
  );
  return [state, actions];
}

const FINE = '(hover: hover) and (pointer: fine)';
/** Smiling, closed eyes for success. */
const JOY = 'M41.8 44.4q1.7-2.4 3.4 0M50.8 44.4q1.7-2.4 3.4 0';
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

/** Eyes go flat for 600 ms after a failure. */
function useFlat(count: number): boolean {
  const [flat, setFlat] = useState(false);
  useEffect(() => {
    if (count === 0) return;
    setFlat(true);
    const t = setTimeout(() => setFlat(false), 600);
    return () => clearTimeout(t);
  }, [count]);
  return flat;
}

/**
 * "The wallet fills" (motion-and-expression.md, moment 8): the mascot sits on the sign-in card's
 * top edge with three passes fanned. Decorative: aria-hidden, no words; every beat is CSS on
 * transform and opacity (login-scene.css).
 */
export function LoginScene({ state, className }: { state: SceneState; className?: string }) {
  const root = state.root;
  const pocket = useRef<HTMLSpanElement>(null);
  const hourglass = useRef<HTMLSpanElement>(null);
  useScenePointer(root);
  useOneShot(pocket, 'shake', state.shake);
  useOneShot(hourglass, 'flip', state.expired);
  const flat = useFlat(state.shake);
  const resting = state.beat === 'rest' || state.beat === 'back';
  // Reduced motion: the letter shows in place, the card never lifts.
  const lift = Boolean(state.letter) && resting && !prefersReducedMotion();
  const mood = state.beat === 'success' ? 'happy' : flat ? 'flat' : undefined;
  return (
    <div
      ref={root}
      className={cn('wl-login-scene', className)}
      data-beat={state.beat === 'rest' ? undefined : state.beat}
      aria-hidden
    >
      <span className="wl-login-lean">
        <span ref={pocket} className="wl-login-pocket">
          <WalletArt
            state="login"
            size="xl"
            lift={lift}
            {...(mood ? { mood } : {})}
            onCard={
              state.letter ? (
                <text key={state.letter} className="wl-login-initial" x="48" y="23">
                  {state.letter}
                </text>
              ) : null
            }
            face={mood === 'happy' ? <path className="m wl-login-joy" d={JOY} /> : null}
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
