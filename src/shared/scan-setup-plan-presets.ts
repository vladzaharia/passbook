import type { ScanSetupIntent, SetupDoor } from './contracts/scan-setup-intent.ts';
import { fillDoor, PRESET_SPECS } from './scan-setup-presets.ts';

type More = NonNullable<SetupDoor['more']>;

/** Doors where anyone scans; a desk (operator) signs staff in. The offline list is the planner's to add, once it knows the door needs no exits. */
function eventNight(door: SetupDoor): SetupDoor {
  const desk = door.devices?.some((d) => d.layout === 'operator') === true;
  const more: More = desk ? { lookup: true } : {};
  return {
    ...door,
    scanners: door.scanners ?? (desk ? { by: 'staff' } : { by: 'anyone', as: 'door' }),
    more: { ...more, ...door.more },
  };
}

/**
 * Fills only what each door leaves out; the derived defaults run after. `venue` adds nothing beyond
 * them: one session per door, directions from the places, plan grant checks.
 */
export function applyPreset(intent: ScanSetupIntent): ScanSetupIntent {
  if (!intent.preset) return intent;
  if (intent.preset === 'event_night') return { ...intent, doors: intent.doors.map(eventNight) };
  const spec = PRESET_SPECS[intent.preset];
  if (!spec.fills) return intent;
  return { ...intent, doors: intent.doors.map((d) => fillDoor(spec, d)) };
}
