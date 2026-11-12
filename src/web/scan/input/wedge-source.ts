/**
 * The keyboard-wedge source (AC 2.4): one capture-phase `keydown` listener on the window.
 * Characters come from `event.code` (US layout); the timing verdict comes from `WedgeDetector`.
 */
import type { ClockPort } from '../machine/ports.ts';
import type { InputSource, RawRead } from './types.ts';
import { charOf, fromKey, isAllowedChar } from './us-keymap.ts';
import {
  WEDGE_STANDARD,
  type WedgeConfig,
  WedgeDetector,
  type WedgeKey,
  type WedgeVerdict,
} from './wedge-detector.ts';

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The scan app's text fields. A burst into one is a scan, and the field is put back as it was. */
export class WedgeFields {
  private readonly setters = new Map<Element, (value: string) => void>();
  register(el: Element, setValue: (value: string) => void): () => void {
    this.setters.set(el, setValue);
    return () => {
      if (this.setters.get(el) === setValue) this.setters.delete(el);
    };
  }
  has(el: Element): boolean {
    return this.setters.has(el);
  }
  restore(el: Element, value: string): void {
    this.setters.get(el)?.(value);
  }
}

export interface WedgeSourceDeps {
  clock: Pick<ClockPort, 'now' | 'setTimeout' | 'clearTimeout'>;
  fields: WedgeFields;
  config?: () => WedgeConfig;
  /** One slow key with nothing editable focused: open lookup with it. */
  onHuman?: (ch: string) => void;
  onFocus?: (focused: boolean) => void;
  /** The running count of bursts typed through the `event.key` fallback outside the scan alphabet. */
  onBadLayout?: (count: number) => void;
  target?: Window;
}

const NON_TEXT = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]);

function isEditable(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !NON_TEXT.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

interface Pressed {
  key: WedgeKey;
  /** The character came from `event.key` because `event.code` was empty. */
  fallback: string | null;
}

function toKey(e: KeyboardEvent, t: number): Pressed {
  if (e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey)
    return { key: { k: 'other', t }, fallback: null };
  if (e.key === 'Shift' || e.key === 'CapsLock') return { key: { k: 'ignore', t }, fallback: null };
  if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')
    return { key: { k: 'end', key: 'Enter', t }, fallback: null };
  if (e.key === 'Tab' || e.code === 'Tab')
    return { key: { k: 'end', key: 'Tab', t }, fallback: null };
  const ch = charOf(e.code, e.shiftKey);
  if (ch !== null) return { key: { k: 'char', ch, t }, fallback: null };
  const fb = e.code === '' ? fromKey(e.key) : null;
  return fb !== null
    ? { key: { k: 'char', ch: fb, t }, fallback: fb }
    : { key: { k: 'other', t }, fallback: null };
}

export function createWedgeSource(deps: WedgeSourceDeps): InputSource & { badLayout(): number } {
  const win = deps.target ?? window;
  let config = (deps.config ?? (() => WEDGE_STANDARD))();
  let detector = new WedgeDetector(config);
  let idle: unknown = null;
  let field: Field | null = null;
  let snapshot = '';
  let fallbackChars: string[] = [];
  let bad = 0;

  function detectorFor(): WedgeDetector {
    const next = (deps.config ?? (() => WEDGE_STANDARD))();
    if (next !== config) {
      config = next;
      detector = new WedgeDetector(config);
    }
    return detector;
  }

  function finish(verdict: Extract<WedgeVerdict, { v: 'scan' }>, emit: (r: RawRead) => void) {
    if (field) deps.fields.restore(field, snapshot);
    const unusual = fallbackChars.some((ch) => !isAllowedChar(ch));
    if (unusual) deps.onBadLayout?.(++bad);
    else if (bad > 0) {
      bad = 0;
      deps.onBadLayout?.(0);
    }
    fallbackChars = [];
    emit({ method: 'wedge', code: verdict.code });
  }

  function start(emit: (read: RawRead) => void): () => void {
    const arm = () => {
      if (idle !== null) deps.clock.clearTimeout(idle);
      idle = deps.clock.setTimeout(() => {
        idle = null;
        const v = detector.flushIdle(deps.clock.now());
        if (v.v === 'scan') finish(v, emit);
        else if (v.v === 'human' && !field) deps.onHuman?.(v.ch);
      }, config.idleAcceptMs);
    };

    const onKeydown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : document.body;
      const registered = deps.fields.has(target);
      if (isEditable(target) && !registered) return;
      const det = detectorFor();
      const t = deps.clock.now();
      const pressed = toKey(e, t);
      if (pressed.key.k === 'char' && det.startsBuffer(t)) {
        field = registered ? (target as Field) : null;
        snapshot = field ? field.value : '';
        fallbackChars = [];
      }
      if (pressed.fallback !== null) fallbackChars.push(pressed.fallback);
      const verdict = det.push(pressed.key);
      if (pressed.key.k === 'char') arm();
      else if (pressed.key.k !== 'ignore' && idle !== null) {
        deps.clock.clearTimeout(idle);
        idle = null;
      }
      if (verdict.v === 'burst' && !registered) e.preventDefault();
      else if (verdict.v === 'scan') {
        e.preventDefault();
        finish(verdict, emit);
      }
    };
    const onBlur = () => deps.onFocus?.(false);
    const onFocus = () => deps.onFocus?.(true);
    win.addEventListener('keydown', onKeydown, true);
    win.addEventListener('blur', onBlur);
    win.addEventListener('focus', onFocus);
    return () => {
      win.removeEventListener('keydown', onKeydown, true);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('focus', onFocus);
      if (idle !== null) deps.clock.clearTimeout(idle);
      idle = null;
      detector.reset();
    };
  }

  return { method: 'wedge', start, badLayout: () => bad };
}
