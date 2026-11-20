import { useEffect, useRef } from 'react';
import { WEDGE_STANDARD } from '../input/wedge-detector.ts';
import { type Command, isPrintable, type KeyContext, type KeyInput, resolveKey } from './keys.ts';
import { type GateClock, QuietGate, realClock } from './keys-gate.ts';
import { dialogOpen, isInteractive, zoneOf } from './workspace/focus.ts';

/** What the workspace knows that a key's meaning depends on. */
export type KeyFacts = Omit<KeyContext, 'zone' | 'interactive'>;

export const keyInputOf = (e: KeyboardEvent): KeyInput => ({
  key: e.key,
  code: e.code,
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
  shift: e.shiftKey,
  composing: e.isComposing,
});

/**
 * One keydown listener for the whole workspace. It runs after the wedge source's capture
 * listener, so a reader's burst has already been taken as a scan and its Enter prevented. Even so
 * a printable key waits out the quiet gap before it acts, and a key that has company inside the
 * gap is dropped: a scan lands, and never fires a shortcut or types into the field.
 */
export function useOperatorKeys(
  facts: () => KeyFacts,
  run: (command: Command) => void,
  clock: GateClock = realClock,
): void {
  const latest = useRef({ facts, run });
  latest.current = { facts, run };
  useEffect(() => {
    const gate = new QuietGate(clock, WEDGE_STANDARD.maxGapMs);
    const onKeyDown = (e: KeyboardEvent) => {
      const input = keyInputOf(e);
      if (isPrintable(input)) {
        if (gate.printable() === 'burst') return;
      } else if (e.key === 'Enter' && gate.terminates()) return;
      if (e.defaultPrevented || dialogOpen()) return;
      if (e.repeat && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target instanceof Element ? e.target : document.activeElement;
      const resolved = resolveKey(input, {
        ...latest.current.facts(),
        zone: zoneOf(target),
        interactive: isInteractive(target),
      });
      if (!resolved) return;
      if (resolved.prevent) e.preventDefault();
      const { command } = resolved;
      if (resolved.deferred) gate.defer(() => latest.current.run(command));
      else latest.current.run(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      gate.cancel();
    };
  }, [clock]);
}
