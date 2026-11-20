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
  /** A registered field is set by its owner; any other text field is put back through its native setter. */
  restore(el: Element, value: string): void {
    const set = this.setters.get(el);
    if (set) set(value);
    else nativeRestore(el, value);
  }
}

/** A window event after every scan the source takes, for UI that held keys while it could not tell. */
export const WEDGE_SCAN_EVENT = 'passbook:wedge-scan';

function nativeRestore(el: Element, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  // React's controlled inputs hear the restore as an input event.
  el.dispatchEvent(new Event('input', { bubbles: true }));
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

/** A text field the scan app owns but did not register (a PIN or code field): a burst is still a scan. */
function isTextField(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !NON_TEXT.has(el.type);
  return el instanceof HTMLTextAreaElement;
}

interface Pressed {
  /** The key came from an input method editor (`Process` or `isComposing`). */
  composing: boolean;
  key: WedgeKey;
  /** The character came from `event.key` because `event.code` was empty. */
  fallback: string | null;
}

function toKey(e: KeyboardEvent, t: number): Pressed {
  // An input method editor reports `Process` and `isComposing`: its keys still carry `code`.
  const composing = e.isComposing || e.key === 'Process';
  const other = (): Pressed => ({ composing, key: { k: 'other', t }, fallback: null });
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return other();
  if (e.key === 'Shift' || e.key === 'CapsLock')
    return { composing, key: { k: 'ignore', t }, fallback: null };
  // A composing Enter commits the person's composition: it is theirs.
  if (composing && (e.key === 'Enter' || e.code === 'Enter')) return other();
  if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')
    return { composing, key: { k: 'end', key: 'Enter', t }, fallback: null };
  if (e.key === 'Tab' || e.code === 'Tab')
    return { composing, key: { k: 'end', key: 'Tab', t }, fallback: null };
  const ch = charOf(e.code, e.shiftKey);
  if (ch !== null) return { composing, key: { k: 'char', ch, t }, fallback: null };
  const fb = e.code === '' ? fromKey(e.key) : null;
  return fb !== null ? { composing, key: { k: 'char', ch: fb, t }, fallback: fb } : other();
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
  let composed = false;

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
    // A scan typed through an IME leaves a composition open in the field: end it.
    if (field && composed) {
      field.blur();
      field.focus();
    }
    composed = false;
    win.dispatchEvent(new Event(WEDGE_SCAN_EVENT));
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
      // A select or an editable region we do not own keeps its keys; any text field of the app is scan-aware.
      if (isEditable(target) && !registered && !isTextField(target)) return;
      const det = detectorFor();
      const t = deps.clock.now();
      const pressed = toKey(e, t);
      if (pressed.key.k === 'char' && det.startsBuffer(t)) {
        field = registered || isTextField(target) ? (target as Field) : null;
        snapshot = field ? field.value : '';
        fallbackChars = [];
        composed = false;
      }
      if (pressed.composing) composed = true;
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
