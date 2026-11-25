/** Setup checks and plan errors, shared by the server, the wizard and the session page. `{x}` marks a value. */
export const SCAN_SETUP_COPY = {
  checks: {
    noExit: 'No one can scan out of {place}. Set a device to In and out.',
    noManager: 'When {place} is full, only a Manager can let people in. Add a Manager.',
    noStaff: '{door} needs staff to sign in. Add a person.',
    planMissesPlace: "{template} has no plan for {place}. Add {place} to a plan or it's refused.",
    hoursDiffer: '{template} ({plan}) and {door} are never open at the same time on {day}.',
    eventNoPasses: '{event} has no passes yet. Issue passes before the doors open.',
    readerBoth: "A barcode reader can't tell in from out. Set {device} to In.",
    placeOnEvent: "{door} admits only events, so it can't check a zone. Remove the zone.",
    directionNeedsTracking:
      "{door} has a direction, but its check-in type doesn't track in and out. Set it to Track in / out.",
    offlineListBlocked: "{door} can't use the offline list. {reason}",
    testOnly:
      'Test mode: these doors admit test passes only. Places and staff are shared with live.',
  },
  fixes: {
    device_direction: 'Set {device} to {direction}',
    add_device: 'Add an exit device',
    add_staff: 'Add a Manager',
    remove_place: 'Remove the zone',
    track_in_out: 'Track in / out',
    open_template: 'Edit {template}',
  },
  issues: {
    SETUP_REF_UNKNOWN: 'Nothing in this setup is called {ref}. Check the name.',
    SETUP_REF_DUPLICATE: '{ref} is used twice. Give each place and event its own ref.',
    SETUP_REF_KIND: '{ref} is not a {kind}. Name a {kind} here.',
    ZONE_NOT_FOUND: 'Zone not found. Pick another zone.',
    ZONE_ARCHIVED: 'This zone is archived. Restore it or pick another.',
    ZONE_CYCLE: "A zone can't sit inside itself. Change where {ref} sits.",
    ZONE_DEPTH: 'Zones nest three levels deep at most. Move {ref} up a level.',
    ZONE_KEY_TAKEN: 'Another zone uses the key {key}. Choose another key.',
    EVENT_NOT_FOUND: 'Event not found. Pick another event.',
    TEMPLATE_NOT_FOUND: 'Pass type not found. Pick another pass type.',
    SETUP_ADMITS_EMPTY: 'Choose a pass type or an event for {door}.',
    SETUP_TOO_MANY_EVENTS: '{door} admits more than 10 events. Remove some.',
    SETUP_TOO_MANY_NEW_EVENTS: 'This setup makes more than 10 events. Remove some.',
    SETUP_TOO_MANY_TEMPLATES: '{door} admits more than 100 pass types. Remove some.',
    SETUP_HARD_LIMIT_NO_CAPACITY:
      '{door} has a hard limit but its place has no max. Set a max inside.',
    SETUP_HOURS_EMPTY: 'Add opening hours for {door}, or set it to always open.',
    SETUP_CLOSES_BEFORE_OPENS: '{event} closes before it opens. Change the times.',
  },
} as const;
export type ScanSetupCheckKey = keyof typeof SCAN_SETUP_COPY.checks;
export type ScanSetupIssueCode = keyof typeof SCAN_SETUP_COPY.issues;
