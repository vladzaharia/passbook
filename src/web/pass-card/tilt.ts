/**
 * The pass stage's pointer tilt, shared by PassCardStage and the /p page (bundled to
 * public/pass-tilt.js by tools/build-ssr-kit.ts). Framework-free; no DOM types, since the Worker
 * typecheck has no DOM lib.
 */

const FINE = '(hover: hover) and (pointer: fine)';
const COARSE = '(pointer: coarse)';
const REDUCED = '(prefers-reduced-motion: reduce)';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface PointerLike {
  clientX: number;
  clientY: number;
}
/** The .pc-stage element: it takes the events and the --px / --py custom properties. */
export interface TiltStage {
  getBoundingClientRect(): Box;
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

/**
 * Fine pointers tilt up to 7° with a following highlight. On touch the card tilts up to 5° while
 * pressed and springs back (480 ms); a vertical move over 8 px hands the gesture to scrolling.
 * Nothing under reduced motion. Returns the unbind.
 */
export function bindTilt(stage: TiltStage): () => void {
  const mq = browser.matchMedia;
  if (typeof mq !== 'function' || mq(REDUCED).matches) return () => {};
  const fine = mq(FINE).matches;
  if (!fine && !mq(COARSE).matches) return () => {};
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
}
