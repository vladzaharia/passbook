import { useSyncExternalStore } from 'react';
import type { Direction, DirectionPin } from '../machine/direction-pin.ts';

/** The pinned direction, live: it lapses on its own. */
export function useDirectionPin(pin: DirectionPin): Direction | null {
  return useSyncExternalStore(pin.subscribe, pin.get, pin.get);
}
