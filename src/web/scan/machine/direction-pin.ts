/** The direction a staff member pinned on a Both scanner. It lapses after 15 minutes without a scan. */
import type { ClockPort } from './ports.ts';

export const PIN_LAPSE_MS = 15 * 60_000;

export type Direction = 'in' | 'out';

export interface DirectionPin {
  get(): Direction | null;
  /** Null goes back to Auto. */
  set(direction: Direction | null): void;
  /** A scan was sent: the lapse starts again. */
  touch(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createDirectionPin(clock: ClockPort): DirectionPin {
  let pin: Direction | null = null;
  let timer: unknown = null;
  const listeners = new Set<() => void>();
  const arm = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (pin === null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      pin = null;
      for (const l of listeners) l();
    }, PIN_LAPSE_MS);
  };
  return {
    get: () => pin,
    set(direction) {
      if (direction === pin) return;
      pin = direction;
      arm();
      for (const l of listeners) l();
    },
    touch: arm,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
