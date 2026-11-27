import type { SIMULATE_EVENTS } from '../contracts/events.ts';

type SimulateEvent = (typeof SIMULATE_EVENTS)[number];

/** The Passes tool's words (design §1.7, §3.4, §3.5, §6). Shared states live in workbench-states.ts. */
export const WB_PASSES = {
  list: { label: 'Passes', count: (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}` },
  view: { label: 'Passes view', all: 'All', phone: 'On my phone' },
  newPass: 'New pass',
  untitled: 'Untitled pass',
  status: { active: 'Active', voided: 'Voided', removed: 'Removed' },
  tabs: { events: 'Events', devices: 'Devices', versions: 'Versions', calls: 'Calls' },
  stage: { label: (title: string) => `${title} preview` },
  phone: {
    org: 'Add to Wallet',
    sandbox: 'Test preview',
    open: 'Open on this phone',
    qrAlt: (title: string) => `QR code to open ${title} on a phone`,
    empty: 'No passes to open on a phone',
    action: 'Make one in Design',
  },
  simulate: {
    label: 'Simulate',
    note: 'Sends real Test events',
    done: 'Event sent',
    failed: 'Could not send',
    events: {
      installed: 'Installed',
      uninstalled: 'Uninstalled',
      scanned: 'Scanned',
      scan_refused: 'Scan refused',
      push_failed: 'Push failed',
      updated_on_device: 'Updated on device',
      email_failed: 'Email failed',
    } satisfies Record<SimulateEvent, string>,
  },
  console: {
    label: 'Open in Console',
    update: 'Update this pass',
    void: 'Void this pass',
    simulate: 'Simulate an event',
  },
  void: {
    action: 'Void',
    title: 'Void this pass?',
    line: "Wallet shows it as void on the holder's device.",
    confirm: 'Void pass',
    cancel: 'Cancel',
    done: 'Pass voided',
    failed: 'Could not void',
  },
  events: {
    title: 'Events',
    sync: 'Sync log',
    empty: 'No events yet',
    request: 'request',
    all: 'All in Events',
  },
  calls: {
    empty: 'No calls for this pass',
    all: 'All in Logs',
  },
} as const;
