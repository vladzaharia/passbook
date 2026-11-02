import { type CSSProperties, useEffect, useRef } from 'react';
import { isDarkBackground } from '../../shared/pass-view/index.ts';
import { PassCard, type PassCardProps } from './PassCard.tsx';
import './stage.css';
import './stage-motion.css';
import './stage-seg.css';

/** SSR-safe: no window access outside effects. */
export interface PassStageProps extends Omit<PassCardProps, 'face'> {
  face?: 'front' | 'back';
  /** Renders both faces so a face change flips the card. */
  flippable?: boolean;
  /** Pointer tilt and shine on fine pointers; press tilt on touch. */
  tilt?: boolean;
  /** Deal the card in on mount (first data arrival with no shared morph). */
  enter?: boolean;
  /** Light from the pass colour under the card. Off for thumbnails and dense grids. */
  glow?: boolean;
  /**
   * Change this value to play the mint (new current content). Never for void or versions.
   * Undefined pauses it (a draft preview): the next defined value is compared with the last one.
   */
  mint?: unknown;
  /** Change this value to dip the card towards the Apple Wallet badge. */
  dip?: unknown;
  /** Change this value to settle the card once (scale 1, .98, 1; void). */
  settle?: unknown;
  /** Voided: no glow, no tilt, and a quiet entrance (fade and 8 px, no tip). */
  dim?: boolean;
  /** A 2 px foil rail runs under the card while true. Any boolean reserves its height. */
  syncing?: boolean;
  /** view-transition-name, so the card morphs between pages. */
  transitionName?: string;
  /** Script-free flip (SSR): a Front / Details radio pair with this id prefix flips the card. */
  toggleId?: string;
}

const FINE = '(hover: hover) and (pointer: fine)';
const COARSE = '(pointer: coarse)';
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
interface PointerLike {
  clientX: number;
  clientY: number;
}
interface Browser {
  matchMedia?: (query: string) => { matches: boolean };
  requestAnimationFrame: (fn: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
}
const browser = globalThis as unknown as Browser;
const el = (ref: { current: unknown }) => ref.current as StageEl | null;

/**
 * Fine pointers tilt up to 7° with a following highlight. On touch the card tilts up to 5° while
 * pressed and springs back (480 ms); a vertical move over 8 px hands the gesture to scrolling.
 */
function useTilt(ref: { current: unknown }, on: boolean) {
  useEffect(() => {
    const stage = el(ref);
    const mq = browser.matchMedia;
    if (!on || !stage || typeof mq !== 'function' || mq(REDUCED).matches) return;
    const fine = mq(FINE).matches;
    if (!fine && !mq(COARSE).matches) return;
    let rect: Box | undefined;
    let frame = 0;
    let start: PointerLike | undefined;
    const clamp = (n: number) => Math.max(-0.5, Math.min(0.5, n));
    const set = (px: number, py: number) => {
      browser.cancelAnimationFrame(frame);
      frame = browser.requestAnimationFrame(() => {
        stage.style.setProperty('--px', px.toFixed(3));
        stage.style.setProperty('--py', py.toFixed(3));
      });
    };
    const track = (e: PointerLike) => {
      rect ??= stage.getBoundingClientRect();
      set(
        clamp((e.clientX - rect.left) / rect.width - 0.5),
        clamp((e.clientY - rect.top) / rect.height - 0.5),
      );
    };
    const enter = () => {
      rect = stage.getBoundingClientRect();
      stage.dataset.tracking = '';
    };
    const leave = () => {
      browser.cancelAnimationFrame(frame);
      rect = undefined;
      start = undefined;
      delete stage.dataset.tracking;
      delete stage.dataset.press;
      stage.style.setProperty('--px', '0');
      stage.style.setProperty('--py', '0');
    };
    const down = (e: PointerLike & { pointerType: string }) => {
      if (e.pointerType !== 'touch') return;
      start = e;
      rect = stage.getBoundingClientRect();
      stage.dataset.press = '';
      track(e);
    };
    const touchMove = (e: PointerLike & { pointerType: string }) => {
      if (!start || e.pointerType !== 'touch') return;
      if (Math.abs(e.clientY - start.clientY) > 8) return leave();
      track(e);
    };
    const events: [string, (e: never) => void][] = fine
      ? [
          ['pointerenter', enter],
          ['pointermove', track],
          ['pointerleave', leave],
        ]
      : [
          ['pointerdown', down],
          ['pointermove', touchMove],
          ['pointerup', leave],
          ['pointercancel', leave],
          ['pointerleave', leave],
        ];
    for (const [type, fn] of events) stage.addEventListener(type, fn);
    return () => {
      browser.cancelAnimationFrame(frame);
      for (const [type, fn] of events) stage.removeEventListener(type, fn);
    };
  }, [ref, on]);
}

/**
 * Replays a one-shot animation (data-<name> on the lift) whenever `value` changes after mount.
 * Undefined is a pause, not a change: the first defined value after it is compared with the last.
 */
function useReplay(ref: { current: unknown }, name: 'mint' | 'dip' | 'settle', value: unknown) {
  // Compare values, not renders: StrictMode runs effects twice on mount.
  const prev = useRef(value);
  useEffect(() => {
    if (value === undefined || Object.is(prev.current, value)) return;
    const first = prev.current === undefined;
    prev.current = value;
    if (first) return;
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
  settle,
  dim,
  syncing,
  transitionName,
  toggleId,
  className,
  target,
}: PassStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const lift = useRef<HTMLDivElement>(null);
  useTilt(stage, tilt && !dim);
  useReplay(lift, 'mint', mint);
  useReplay(lift, 'dip', dip);
  useReplay(lift, 'settle', settle);
  const both = flippable || Boolean(toggleId);
  const c = view.colors;
  // A very dark pass would cast no visible glow: mix in its label colour.
  const glowColor = isDarkBackground(c.background)
    ? `color-mix(in srgb, ${c.label} 60%, ${c.background})`
    : c.background;
  const style = {
    '--pc-glow': glowColor,
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
      data-tilt={(tilt && !dim) || undefined}
      data-enter={enter ? (dim ? 'quiet' : '') : undefined}
      data-glow={glow ? undefined : 'off'}
      data-dim={dim || undefined}
      data-single={both ? undefined : ''}
      style={style}
    >
      {toggleId ? (
        <>
          <input
            id={`${toggleId}-front`}
            type="radio"
            name={toggleId}
            defaultChecked
            className="pc-flip-front pc-sr"
          />
          <input id={toggleId} type="radio" name={toggleId} className="pc-flip-toggle pc-sr" />
        </>
      ) : null}
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
      {syncing === undefined ? null : (
        <span className="pc-sync-rail wl-essential" data-on={syncing || undefined} aria-hidden />
      )}
      {toggleId ? (
        <fieldset className="pc-seg">
          <legend className="pc-sr">Side</legend>
          <label htmlFor={`${toggleId}-front`}>Front</label>
          <label htmlFor={toggleId}>Details</label>
        </fieldset>
      ) : null}
    </div>
  );
}
