import { type CSSProperties, useEffect, useRef } from 'react';
import { PassCard, type PassCardProps } from './PassCard.tsx';
import './stage.css';

/** SSR-safe: no window access outside effects. */
export interface PassStageProps extends Omit<PassCardProps, 'face'> {
  face?: 'front' | 'back';
  /** Renders both faces so a face change flips the card. */
  flippable?: boolean;
  /** Pointer tilt and shine on fine pointers. */
  tilt?: boolean;
  /** Deal the card in on mount. */
  enter?: boolean;
  /** Light from the pass colour under the card. Off for thumbnails and dense grids. */
  glow?: boolean;
  /** Change this value (compared by identity) to play the mint sheen: created, refreshed. */
  mint?: unknown;
  /** Change this value to dip the card towards Add to Apple Wallet. */
  dip?: unknown;
  /** view-transition-name, so the card morphs between pages. */
  transitionName?: string;
  /** Script-free flip (SSR): a checkbox with this id flips the card through CSS. */
  toggleId?: string;
  toggleLabel?: string;
}

const FINE = '(hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

// The Worker typecheck has no DOM lib; effects only run in the browser, so type what they use.
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface StageEl {
  getBoundingClientRect(): Box;
  readonly offsetWidth: number;
  style: { setProperty(name: string, value: string): void };
  dataset: Record<string, string | undefined>;
  addEventListener(type: string, fn: (e: never) => void): void;
  removeEventListener(type: string, fn: (e: never) => void): void;
}
interface Browser {
  matchMedia?: (query: string) => { matches: boolean };
  requestAnimationFrame: (fn: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
}
const browser = globalThis as unknown as Browser;
const el = (ref: { current: unknown }) => ref.current as StageEl | null;

function usePointerTilt(ref: { current: unknown }, on: boolean) {
  useEffect(() => {
    const stage = el(ref);
    const mq = browser.matchMedia;
    if (!on || !stage || typeof mq !== 'function') return;
    if (!mq(FINE).matches || mq(REDUCED).matches) return;
    let rect: Box | undefined;
    let frame = 0;
    const clamp = (n: number) => Math.max(-0.5, Math.min(0.5, n));
    const move = (e: { clientX: number; clientY: number }) => {
      rect ??= stage.getBoundingClientRect();
      const px = clamp((e.clientX - rect.left) / rect.width - 0.5);
      const py = clamp((e.clientY - rect.top) / rect.height - 0.5);
      browser.cancelAnimationFrame(frame);
      frame = browser.requestAnimationFrame(() => {
        stage.style.setProperty('--px', px.toFixed(3));
        stage.style.setProperty('--py', py.toFixed(3));
      });
    };
    const enter = () => {
      rect = stage.getBoundingClientRect();
      stage.dataset.tracking = '';
    };
    const leave = () => {
      browser.cancelAnimationFrame(frame);
      rect = undefined;
      delete stage.dataset.tracking;
      stage.style.setProperty('--px', '0');
      stage.style.setProperty('--py', '0');
    };
    stage.addEventListener('pointerenter', enter);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', leave);
    return () => {
      browser.cancelAnimationFrame(frame);
      stage.removeEventListener('pointerenter', enter);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerleave', leave);
    };
  }, [ref, on]);
}

/** Replays a one-shot animation (data-<name> on the lift) whenever `value` changes after mount. */
function useReplay(ref: { current: unknown }, name: 'mint' | 'dip', value: unknown) {
  // Compare values, not renders: StrictMode runs effects twice on mount.
  const prev = useRef(value);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    const lift = el(ref);
    if (!lift) return;
    delete lift.dataset[name];
    void lift.offsetWidth; // restart the animation
    lift.dataset[name] = '';
    const done = (e: { target: unknown }) => {
      if (e.target === lift) delete lift.dataset[name];
    };
    lift.addEventListener('animationend', done);
    return () => lift.removeEventListener('animationend', done);
  }, [ref, name, value]);
}

export function PassCardStage({
  view,
  face = 'front',
  flippable = false,
  tilt = true,
  enter = false,
  glow = true,
  mint,
  dip,
  transitionName,
  toggleId,
  toggleLabel = 'Show back',
  className,
  target,
}: PassStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const lift = useRef<HTMLDivElement>(null);
  usePointerTilt(stage, tilt);
  useReplay(lift, 'mint', mint);
  useReplay(lift, 'dip', dip);
  const both = flippable || Boolean(toggleId);
  const style = {
    '--pc-glow': view.colors.background,
    ...(transitionName ? { viewTransitionName: transitionName } : {}),
  } as CSSProperties;
  const side = (s: 'front' | 'back') => {
    // A CSS-only toggle cannot set inert; the stylesheet hides the far face instead.
    const hidden = !toggleId && s !== face;
    return (
      <div className="pc-face" data-side={s} inert={hidden}>
        <PassCard view={view} face={s} {...(target ? { target } : {})} />
        <span className="pc-shine" aria-hidden />
        <span className="pc-sheen" aria-hidden />
      </div>
    );
  };
  return (
    <div
      ref={stage}
      className={className ? `pc-stage ${className}` : 'pc-stage'}
      data-face={face}
      data-tilt={tilt || undefined}
      data-enter={enter || undefined}
      data-glow={glow ? undefined : 'off'}
      data-single={both ? undefined : ''}
      style={style}
    >
      {toggleId ? <input id={toggleId} type="checkbox" className="pc-flip-toggle pc-sr" /> : null}
      <div ref={lift} className="pc-lift">
        <div className="pc-flipper">
          {both ? (
            <>
              {side('front')}
              {side('back')}
            </>
          ) : (
            side(face)
          )}
        </div>
      </div>
      {toggleId ? (
        <label htmlFor={toggleId} className="pc-flip-label">
          {toggleLabel}
        </label>
      ) : null}
    </div>
  );
}
