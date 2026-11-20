import { useEffect, useRef } from 'react';
import { WEDGE_SLOW, WEDGE_STANDARD } from '../input/wedge-detector.ts';
import { WEDGE_SCAN_EVENT } from '../input/wedge-source.ts';
import {
  type Command,
  detectPlatform,
  isPrintable,
  type KeyContext,
  type KeyInput,
  resolveKey,
} from './keys.ts';
import { type GateClock, QuietGate, realClock } from './keys-gate.ts';
import { dialogOpen, isInteractive, zoneOf } from './workspace/focus.ts';

/** What the workspace knows that a key's meaning depends on. */
export type KeyFacts = Omit<
  KeyContext,
  'zone' | 'interactive' | 'platform' | 'textHere' | 'typingRecently'
>;

export const keyInputOf = (e: KeyboardEvent): KeyInput => ({
  key: e.key,
  code: e.code,
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
  shift: e.shiftKey,
  composing: e.isComposing,
});

const hasText = (el: Element | null): boolean =>
  (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.length > 0;

const stamp = (e: KeyboardEvent) => e.timeStamp;

export interface KeysOptions {
  clock?: GateClock;
  /** A key's time. The event's own stamp by default, so a long task cannot split a burst. */
  timeOf?: (e: KeyboardEvent) => number;
}

/**
 * One keydown listener for the whole workspace. It runs after the wedge source's capture
 * listener, so a reader's burst has already been taken as a scan and its Enter prevented. Even so
 * a printable key waits out the quiet gap before it acts, and a key that has company inside the
 * gap is held: a scan lands and never fires a shortcut or types into the field, and a fast typist's
 * run is replayed into search once the wedge has declined it.
 */
export function useOperatorKeys(
  facts: () => KeyFacts,
  run: (command: Command) => void,
  options: KeysOptions = {},
): void {
  const latest = useRef({ facts, run });
  latest.current = { facts, run };
  const { clock = realClock, timeOf = stamp } = options;
  useEffect(() => {
    // The replay waits for the wedge's idle flush, which ends a scan sent without a terminator.
    const gate = new QuietGate(clock, WEDGE_STANDARD.maxGapMs, WEDGE_STANDARD.idleAcceptMs + 50);
    const platform = detectPlatform();
    const replay = (text: string) => {
      if (zoneOf(document.activeElement) === 'record' && !dialogOpen())
        latest.current.run({ c: 'type', ch: text });
    };
    const onScan = () => gate.scanSeen();
    const onKeyDown = (e: KeyboardEvent) => {
      const input = keyInputOf(e);
      const target = e.target instanceof Element ? e.target : document.activeElement;
      const zone = zoneOf(target);
      const t = timeOf(e);
      // How long the keyboard was quiet before this key: a shortcut needs a quiet lead-in.
      const quietBefore = gate.sinceLast(t);
      if (isPrintable(input)) {
        if (gate.printable(t) === 'burst') {
          if (zone === 'record' && input.key !== ' ' && !dialogOpen()) gate.hold(input.key, replay);
          return;
        }
        // A lone key after a fast run belongs to the run: a typist's rhythm is fast pair, then slower.
        // While the run is undecided no key of it may act as a shortcut.
        if (gate.holding() && zone === 'record' && input.key !== ' ' && !dialogOpen()) {
          gate.hold(input.key, replay);
          return;
        }
      } else if (e.key === 'Enter' && zone === 'record' && gate.terminates(t)) return;
      if (e.defaultPrevented || dialogOpen()) return;
      if (e.repeat && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const resolved = resolveKey(input, {
        ...latest.current.facts(),
        platform,
        zone,
        interactive: isInteractive(target),
        textHere: hasText(target),
        // A slow reader's last key can land long after the rest: Enter after typing is not primary.
        typingRecently: gate.sinceLast(t) < WEDGE_SLOW.idleAcceptMs,
      });
      if (!resolved) return;
      // A letter shortcut right behind other keys is a slow reader's data, not a request.
      if (
        resolved.deferred &&
        resolved.command.c !== 'type' &&
        quietBefore < WEDGE_SLOW.idleAcceptMs
      )
        return;
      if (resolved.prevent) e.preventDefault();
      const { command } = resolved;
      if (resolved.deferred) {
        gate.hold(input.key, replay);
        gate.defer(() => latest.current.run(command));
      } else {
        gate.drop();
        latest.current.run(command);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(WEDGE_SCAN_EVENT, onScan);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(WEDGE_SCAN_EVENT, onScan);
      gate.dispose();
    };
  }, [clock, timeOf]);
}
