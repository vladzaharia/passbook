import type { ScanSetupIntent, SetupDoor } from './contracts/scan-setup-intent.ts';

type More = NonNullable<SetupDoor['more']>;
/** The preset's value for each setting the door leaves out. */
const fill = (more: SetupDoor['more'], preset: More): More => ({ ...preset, ...more });

function frontDesk(door: SetupDoor): SetupDoor {
  return {
    ...door,
    scanners: door.scanners ?? { by: 'staff' },
    devices: door.devices ?? [{ layout: 'operator' }, { layout: 'auto' }],
    more: fill(door.more, { lookup: true, showPhoto: true, deskActions: true }),
  };
}

/** Doors where anyone scans; a desk (operator) signs staff in. The offline list is the planner's to add, once it knows the door needs no exits. */
function eventNight(door: SetupDoor): SetupDoor {
  const desk = door.devices?.some((d) => d.layout === 'operator') === true;
  return {
    ...door,
    scanners: door.scanners ?? (desk ? { by: 'staff' } : { by: 'anyone', as: 'door' }),
    more: fill(door.more, desk ? { lookup: true } : {}),
  };
}

/**
 * Fills only what each door leaves out; the derived defaults run after. `venue` adds nothing beyond
 * them: one session per door, directions from the places, plan grant checks.
 */
export function applyPreset(intent: ScanSetupIntent): ScanSetupIntent {
  if (intent.preset === 'front_desk') return { ...intent, doors: intent.doors.map(frontDesk) };
  if (intent.preset === 'event_night') return { ...intent, doors: intent.doors.map(eventNight) };
  return intent;
}
