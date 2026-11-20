/** Which way a scanner reads now: the setting, the staff's 15 minute pin, the session's scope. Pure. */
import type { Direction } from './direction-pin.ts';

export type DirectionSetting = 'in' | 'out' | 'both';
export type ShownDirection = Direction | 'auto';

/** A fixed scanner reads its setting; a Both scanner reads the pin, else the scope's Out, else Auto. */
export function shownDirection(
  setting: DirectionSetting,
  pin: Direction | null,
  scope: Direction,
): ShownDirection {
  if (setting !== 'both') return setting;
  return pin ?? (scope === 'out' ? 'out' : 'auto');
}

/**
 * The thumb button's next pin: Auto, In, Out, and round again (Auto is no pin). A session whose scope
 * is Out reads Out with no pin, so Out is already where it stands: it goes to In, and back to that.
 */
export const nextDirection = (shown: ShownDirection, scope: Direction = 'in'): Direction | null => {
  if (scope === 'out') return shown === 'out' ? 'in' : null;
  return shown === 'auto' ? 'in' : shown === 'in' ? 'out' : null;
};
