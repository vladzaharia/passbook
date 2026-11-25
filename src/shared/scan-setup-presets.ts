import type {
  ScanSetupPreset,
  SetupDevice,
  SetupDoor,
  SetupHours,
} from './contracts/scan-setup-intent.ts';

type More = NonNullable<SetupDoor['more']>;
type Scanners = NonNullable<SetupDoor['scanners']>;

/** What a preset answers: the labels, the shape of Where, and what it fills for a door that leaves it out. */
export interface PresetSpec {
  label: string;
  /** The wizard's name chips; the first is the start. */
  names: readonly [string, ...string[]];
  /** Where asks for: nothing, one counted area (`count` names it and starts it on) or an area tree. */
  where: 'none' | 'count' | 'areas';
  count?: string;
  scanners: Scanners;
  devices: SetupDevice[];
  more: More;
  hours?: SetupHours;
  /** Keeps the line moving offline, for a door that needs no exits. */
  offlineList?: boolean;
  /** False: the answers start the wizard, and `applyPreset` adds nothing or decides itself. */
  fills: boolean;
}

export const PRESET_SPECS: Record<ScanSetupPreset, PresetSpec> = {
  front_desk: {
    label: 'Front desk',
    names: ['Front desk', 'Main door', 'Reception'],
    where: 'count',
    scanners: { by: 'staff' },
    devices: [{ layout: 'operator' }, { layout: 'auto' }],
    more: { lookup: true, showPhoto: true, deskActions: true },
    fills: true,
  },
  event_night: {
    label: 'Event night',
    names: ['Doors', 'Main entrance', 'Gate'],
    where: 'none',
    scanners: { by: 'anyone', as: 'door' },
    devices: [{ layout: 'auto' }],
    more: {},
    offlineList: true,
    fills: false,
  },
  venue: {
    label: 'Several areas',
    names: ['Main door', 'Pool gate', 'Side entrance'],
    where: 'areas',
    scanners: { by: 'anyone', as: 'door' },
    devices: [{ layout: 'auto' }],
    more: {},
    fills: false,
  },
  club: {
    label: 'Club entry',
    names: ['Entrance', 'Main door', 'Turnstile'],
    where: 'count',
    count: 'Inside',
    scanners: { by: 'anyone', as: 'door' },
    devices: [
      { layout: 'phone', direction: 'in' },
      { layout: 'phone', direction: 'out' },
    ],
    more: { checkIn: { mode: 'in_out' } },
    fills: true,
  },
  conference: {
    label: 'Conference',
    names: ['Badge desk', 'Registration', 'Main entrance'],
    where: 'none',
    scanners: { by: 'staff' },
    devices: [{ layout: 'operator' }, { layout: 'phone' }],
    more: { checkIn: { mode: 'daily' }, lookup: true, showPhoto: true, deskActions: true },
    hours: { every: ['08:00-18:00'] },
    fills: true,
  },
  gates: {
    label: 'Ticket gates',
    names: ['Gate A', 'Main gate', 'Entrance'],
    where: 'none',
    scanners: { by: 'anyone', as: 'door' },
    devices: [{ layout: 'phone' }, { layout: 'phone' }, { layout: 'phone', reader: 'barcode' }],
    more: { checkIn: { mode: 'single' } },
    offlineList: true,
    fills: true,
  },
  counter: {
    label: 'Counter',
    names: ['Counter', 'Till', 'Cafe'],
    where: 'none',
    scanners: { by: 'anyone', as: 'desk' },
    devices: [{ layout: 'operator' }, { layout: 'customer' }],
    more: {
      checkIn: { mode: 'unlimited' },
      flow: 'choose',
      lookup: true,
      deskActions: true,
      customer: { greet: true, showReady: true },
    },
    fills: true,
  },
  pickup: {
    label: 'Pickup',
    names: ['Pickup', 'Collection', 'Will call'],
    where: 'none',
    scanners: { by: 'staff' },
    devices: [{ layout: 'operator' }],
    more: { checkIn: { mode: 'single' }, lookup: true, deskActions: true },
    fills: true,
  },
  timed: {
    label: 'Timed entry',
    names: ['Entrance', 'Ticket check', 'Main door'],
    where: 'count',
    count: 'Galleries',
    scanners: { by: 'anyone', as: 'door' },
    devices: [{ layout: 'phone' }, { layout: 'phone' }],
    more: { checkIn: { mode: 'in_out' }, hardLimit: true },
    hours: { every: ['09:00-17:00'] },
    fills: true,
  },
};

/** Fills what the door leaves out; the door's own `more` wins setting by setting. */
export function fillDoor(spec: PresetSpec, door: SetupDoor): SetupDoor {
  return {
    ...door,
    scanners: door.scanners ?? spec.scanners,
    devices: door.devices ?? spec.devices,
    ...(door.hours === undefined && spec.hours ? { hours: spec.hours } : {}),
    more: { ...spec.more, ...door.more },
  };
}
