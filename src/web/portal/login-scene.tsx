import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { WalletArt } from '../ui/index.ts';
import './login-scene.css';

/** What the wallet is doing: tucked cards, the top card sent off, or the cards dropping home. */
export type SceneBeat = 'rest' | 'sent' | 'success';

export interface SceneState {
  beat: SceneBeat;
  /** First letter of a valid address: the top card lifts and shows it. */
  letter: string | null;
  /** Bumped per failure: one shake and flat eyes. */
  shake: number;
  /** Bumped when a code turns out to be expired: the hourglass flips. */
  expired: number;
}

export interface SceneActions {
  setLetter: (letter: string | null) => void;
  send: () => void;
  back: () => void;
  fail: (opts?: { expired?: boolean }) => void;
  succeed: () => void;
}

/** Scene state for the sign-in page; the card drives it through the actions. */
export function useLoginScene(): [SceneState, SceneActions] {
  const [state, setState] = useState<SceneState>({
    beat: 'rest',
    letter: null,
    shake: 0,
    expired: 0,
  });
  const actions = useMemo<SceneActions>(
    () => ({
      setLetter: (letter) => setState((s) => (s.letter === letter ? s : { ...s, letter })),
      send: () => setState((s) => ({ ...s, beat: 'sent' })),
      back: () => setState((s) => ({ ...s, beat: 'rest' })),
      fail: (opts) =>
        setState((s) => ({
          ...s,
          shake: s.shake + 1,
          expired: opts?.expired ? s.expired + 1 : s.expired,
        })),
      succeed: () => setState((s) => ({ ...s, beat: 'success' })),
    }),
    [],
  );
  return [state, actions];
}

const FINE = '(hover: hover) and (pointer: fine)';
const MAX_LEAN = 4;

/** Fine pointers: the wallet leans toward the pointer, at most 4°. One rAF-throttled listener. */
function useLean(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof matchMedia !== 'function' || !matchMedia(FINE).matches) return;
    if (prefersReducedMotion()) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect();
        const half = Math.max(window.innerWidth / 2, 1);
        const x = (e.clientX - (box.left + box.width / 2)) / half;
        const lean = Math.max(-1, Math.min(1, x)) * MAX_LEAN;
        el.style.setProperty('--lean', `${lean.toFixed(2)}deg`);
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
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
 * "The wallet fills" (motion-and-expression.md, moment 8): the mascot peeks over the sign-in
 * card. Decorative: aria-hidden, no words; every beat is CSS on transform and opacity.
 */
export function LoginScene({ state, className }: { state: SceneState; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const pocket = useRef<HTMLSpanElement>(null);
  const hourglass = useRef<HTMLSpanElement>(null);
  useLean(root);
  useOneShot(pocket, 'shake', state.shake);
  useOneShot(hourglass, 'flip', state.expired);
  const flat = useFlat(state.shake);
  const reduced = prefersReducedMotion();
  // Reduced motion: the letter shows in place, the card never lifts.
  const lift = Boolean(state.letter) && state.beat === 'rest' && !reduced;
  return (
    <div
      ref={root}
      className={cn('wl-login-scene', className)}
      data-beat={state.beat === 'rest' ? undefined : state.beat}
      aria-hidden
    >
      <span className="wl-login-lean">
        <span ref={pocket} className="wl-login-pocket">
          <WalletArt state="login" size="xl" lift={lift} {...(flat ? { mood: 'flat' } : {})} />
          <svg
            aria-hidden="true"
            className="wl-art wl-login-letter"
            data-art="wallet"
            data-state="login"
            viewBox="0 0 96 72"
            focusable="false"
          >
            <g data-part="w" data-b="" data-lift={lift ? '' : undefined}>
              <g data-part="c2" data-i="1" data-on={state.letter ? '' : undefined}>
                <text x="48" y="23">
                  {state.letter ?? ''}
                </text>
              </g>
            </g>
          </svg>
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
