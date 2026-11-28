import type { ScanReason } from '../contracts/scan.ts';
import { SCAN_HELP_COPY } from './scan-help.ts';
import { SCAN_READER_COPY } from './scan-readers.ts';
import { SCAN_TAG_COPY } from './scan-tags.ts';

/** Reasons that only the client makes: they never reach the wire. */
export type ClientScanReason =
  | 'network'
  | 'timeout'
  | 'unconfirmed'
  | 'still_unconfirmed'
  | 'server'
  | 'rate_limited'
  | 'forbidden'
  | 'saved_offline'
  | 'offline_decide'
  | 'not_listed'
  | 'add_link';

export interface ScanLine {
  headline: string;
  /** `{name}` marks a value; fill it with `scanLine`. */
  sub: string;
}

/** Every verdict line of the scanner. `/scan`, the admin pages and the CSV read this one file. */
export const SCAN_REASON_COPY: Record<ScanReason | ClientScanReason, ScanLine> = {
  not_found: { headline: 'Not found', sub: "This code isn't a pass here." },
  code_replaced: { headline: 'Replaced code', sub: 'Check ID.' },
  ambiguous: { headline: 'More than one match', sub: 'Enter the code or name.' },
  test_pass: {
    headline: 'Test pass',
    sub: "Live scanners don't take test passes. Use a test scanner.",
  },
  live_pass: { headline: 'Live pass', sub: 'This is a test scanner. Use a live scanner.' },
  not_accepted: {
    headline: 'Not accepted here',
    sub: "{template} isn't on this scanner. Use another scanner.",
  },
  wrong_event: { headline: 'Wrong event', sub: 'This scanner is for {event}, {day}.' },
  removed: { headline: 'Removed', sub: 'Removed {date}. Ask for a new pass.' },
  voided: { headline: 'Voided', sub: 'Voided {date}. Ask for a new pass.' },
  expired: { headline: 'Expired', sub: 'Ended {date}.' },
  no_balance: { headline: 'Not enough balance', sub: '{have} left. Needs {need}.' },
  card_full: { headline: 'Card is full', sub: 'Redeem the reward first.' },
  managed_elsewhere: {
    headline: 'Set by a connection',
    sub: '{input} come from a connection. Change them there.',
  },
  limit_reached: {
    headline: 'Daily limit reached',
    sub: "This scanner's limit resets at midnight. Use another scanner.",
  },
  zone_not_included: {
    headline: 'Not in plan',
    sub: "{plan} doesn't include {zone}. Ask a manager.",
  },
  outside_hours: { headline: 'Outside hours', sub: '{plan} opens {when}.' },
  guest_expired: { headline: 'Guest pass ended', sub: 'Ended {time}. Ask a manager.' },
  guest_visits_used: { headline: 'No visits left', sub: 'Used {used} of {limit}.' },
  suspended: { headline: 'Suspended', sub: 'Ask a manager.' },
  tag_lost: { headline: 'Tag reported lost', sub: 'Keep it and call security.' },
  tag_not_allowed: { headline: 'Tag not accepted', sub: "This tag isn't accepted here." },
  tag_invalid: { headline: "Tag couldn't be checked", sub: 'Try again or use the card.' },
  tag_expired: {
    headline: 'Tag assignment ended',
    sub: 'Assign it again at the desk.',
  },
  channel_off: { headline: '{channel} turned off', sub: 'Use another copy or check ID.' },
  print_replaced: { headline: 'Reprinted', sub: 'Newer copy printed {date}. Check ID.' },
  print_voided: { headline: 'Printed copy voided', sub: 'Voided {date}. Ask for a new ticket.' },
  already_done: { headline: 'Already {done}', sub: '{ago} at {scanner}. Check ID.' },
  cooldown: { headline: 'Just done', sub: '{action} at {time}. Next in {wait}.' },
  not_yet_valid: { headline: 'Not open yet', sub: 'Opens {day} {time}.' },
  ended: { headline: '{place} ended', sub: 'Ended {time}.' },
  capacity_full: { headline: '{place} full', sub: '{in} of {capacity} in.' },
  check_required: { headline: '{flag}', sub: 'Check it, then tap {action}.' },
  needs_approval: { headline: 'Needs a manager', sub: '{action} needs a manager.' },
  stale: { headline: '{input} changed', sub: 'Now {value}. Check it and set again.' },
  in_progress: {
    headline: 'Being scanned',
    sub: 'Another scanner has this pass. Scan again in a moment.',
  },
  still_inside: { headline: 'Already in', sub: 'Since {time} · {scanner}. Check ID.' },
  not_inside: { headline: 'Not tapped in', sub: 'No entry recorded. Tap them in first.' },
  choose: { headline: 'Choose an action', sub: 'Pick what to do with this pass.' },
  network: { headline: 'No connection', sub: 'Not checked. Hold them and scan again.' },
  timeout: { headline: 'No answer', sub: 'Not checked. Hold them and scan again.' },
  unconfirmed: { headline: 'Not confirmed', sub: "Checking again when you're back online." },
  still_unconfirmed: { headline: 'Still not confirmed', sub: 'Check Recent before trying again.' },
  server: { headline: 'Something went wrong', sub: 'Scan again.' },
  rate_limited: { headline: 'Too many scans', sub: 'Try again in {seconds} s.' },
  forbidden: { headline: 'Not allowed', sub: "This device can't do that. Ask a manager." },
  saved_offline: { headline: '{action}', sub: 'Saved offline' },
  offline_decide: {
    headline: 'No connection',
    sub: 'Check it by eye. Tap {action} to save it for later.',
  },
  not_listed: { headline: 'Not found', sub: 'Not on the offline list from {time}.' },
  add_link: { headline: 'Add-to-Wallet link', sub: 'Ask them to open the pass in Wallet.' },
};

/** Fills `{name}` markers. A missing value stays as its marker so a gap is visible in tests. */
export function scanLine(text: string, values: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (marker, key: string) =>
    key in values ? String(values[key]) : marker,
  );
}

/** The display's system captions (DM 3.5). */
export const SCAN_DISPLAY_COPY = {
  moreFor: '{n} more for {reward}',
  rewardsReady: { one: '{n} reward ready', other: '{n} rewards ready' },
  rewardReadySaved: {
    one: '{n} reward ready · {saved} saved',
    other: '{n} rewards ready · {saved} saved',
  },
  changedElsewhere: 'Changed elsewhere',
  noPhoto: 'No photo',
  lowBalance: 'Low balance',
  noVisits: 'No visits yet.',
  /** The editor marks a row the render-time budget would drop. */
  cutOnThisScreen: 'Cut on this screen',
} as const;

/** The flag of a typed number a door must check: it picks the typed-number line. */
export const TYPED_NUMBER_FLAG = 'Typed number';

/** Refusal sub-lines for a reason whose plan has nothing to say. They never ride a grant. */
export const SCAN_REASON_VARIANTS = {
  outside_hours: { noHours: '{plan} has no hours this week. Ask a manager.' },
  zone_not_included: { noZone: '{plan} opens no zone here. Ask a manager.' },
  needs_approval: {
    headline: 'Needs a manager or desk lead',
    sub: '{action} needs approval.',
  },
  already_done: { noPrevious: 'Scanned earlier. Check ID.', short: '{ago} · {scanner}' },
  wrong_event: { noEvent: 'This scanner is for a different event.' },
  not_yet_valid: { noWhen: 'Not open yet. Try again later.' },
  capacity_full: { noPlace: 'Full', noCapacity: '{in} in.', noCount: 'At capacity.' },
  ended: { noPlace: 'Ended', named: '{type} ended' },
  guest_expired: { named: '{type} ended' },
  guest_visits_used: { named: '{type}: no visits left' },
  check_required: { typedNumber: 'Check ID.' },
} as const;

/** In/out lines that replace a reason's default when the place is a zone or the state is known. */
export const SCAN_OCCUPANCY_COPY: Record<string, ScanLine> = {
  zoneFull: { headline: '{zone} full', sub: '{in} of {capacity} in.' },
  eventStillIn: { headline: 'Already checked in', sub: 'Since {time} · {scanner}. Check ID.' },
  stillInRecent: { headline: 'Already in', sub: '{ago} · {scanner}. Check ID.' },
  eventNotIn: { headline: 'Not checked in', sub: 'Check them in instead?' },
  parentNotIn: { headline: 'Not tapped in', sub: 'Tap in at {zone} first.' },
  alreadyOut: { headline: 'Already out', sub: '{ago} · {scanner}' },
};

/** Refusals on a counter ("7 left"): used in place of the balance and stamp-card lines. */
export const SCAN_COUNTER_COPY: Record<string, ScanLine> = {
  no_balance: { headline: 'None left', sub: 'Refill it first.' },
  card_full: { headline: 'Already full', sub: 'Use some first.' },
};

export const SCAN_COPY = {
  help: SCAN_HELP_COPY,
  reasons: SCAN_REASON_COPY,
  display: SCAN_DISPLAY_COPY,
  tags: SCAN_TAG_COPY,
  readers: SCAN_READER_COPY,
  verdict: {
    checkedIn: 'Checked in',
    /** The word of an `already_done` headline: a check-in is `checked in`, any other action `done`. */
    already: { checkIn: 'checked in', other: 'done' },
    checkedOut: 'Checked out',
    noExitSub: 'This pass only allows entry.',
    noReentrySub: 'One entry only. Check ID.',
    redeemed: 'Redeemed',
    /** An Access card's check-in. The sub joins the zone and the closing time that exist. */
    access: {
      headline: 'Access granted',
      sub: '{zone} · until {time}',
    },
    /** The pass type and the rule that admitted it: "Day pass · until 11:59 PM". */
    admit: {
      line: '{type} · {rule}',
      until: 'until {time}',
      visit: 'visit {n} of {of}',
      left: '{n} left',
      once: 'once',
      daily: 'daily',
    },
    letInAgain: 'Let in again.',
    tappedOut: 'Tapped out',
    /** The sub of an exit. */
    tappedOutSub: '{zone} · {stay}',
    autoOut: 'Tapped out automatically after {stay} or at {time}.',
    letInBy: '{zone} · Let in by {staff}',
    letInByStrip: 'Let in by {staff} at {scanner}',
    resolvedBy: 'Resolved by {staff}',
    overrideUndone: 'Override undone',
    overrideTaken: '{staff} already let them in.',
    stamps: { one: '+{n} stamp', other: '+{n} stamps' },
    balanceSet: '{input} set',
  },
  actions: {
    done: 'Done',
    letInAgain: 'Let in again',
    tapIn: 'Tap in',
    tapOut: 'Tap out',
    checkOut: 'Check out',
    markAsOut: 'Mark as out',
    letIn: 'Let in',
    signInToAct: 'Sign in to act',
    letInAnyway: 'Let in anyway',
    addAnyway: 'Add anyway',
    managerPin: 'Manager PIN',
    askManager: 'Ask a manager',
    askAdmin: 'Ask an admin to allow it.',
    review: 'Review',
    back: 'Back',
    cancel: 'Cancel',
    undo: 'Undo',
    redeemReward: 'Redeem reward',
    lookUp: 'Look up',
    tryAgain: 'Try again',
    startScanning: 'Start scanning',
    pair: 'Pair',
    join: 'Join',
    pairAgain: 'Pair again',
    reload: 'Reload',
    endShift: 'End shift',
    startNewShift: 'Start new shift',
    unpair: 'Unpair',
  },
  boot: {
    pairTitle: 'Pair this device',
    pairLine: 'Enter the code from Admin > Scanning, or scan its QR with your camera.',
    pairLabel: 'Pairing code',
    pairFooter: 'No code? Ask an admin.',
    adminAs: 'Signed in as {who}',
    codeInvalid: 'Code not valid. Ask for a new one.',
    tooManyTries: 'Too many tries. Wait a minute and try again.',
    offline: "No connection. Pair when you're back online.",
    removedTitle: 'Scanner removed',
    removedLine: 'Ask an admin for a new code.',
    expiredTitle: 'Pairing expired',
    suspendedTitle: 'Organization suspended',
    suspendedLine: 'Scanning is off until an admin restores it.',
    unassignedTitle: 'Not set up',
    unassignedLine: 'Ask an admin to choose what this scanner accepts.',
    signedOutTitle: 'Signed out',
    signedOutLine: 'Sign in again to keep scanning.',
    whoIsScanning: "Who's scanning?",
    enterPin: 'Enter your PIN',
    wrongPin: 'Wrong PIN. {n} tries left.',
    pinLocked: 'Too many tries. Try again in {wait}.',
    screenOnlyTitle: 'This device is a screen.',
    screenOnlyLine: 'Ask an admin to change it.',
  },
  lookup: {
    placeholder: 'Name, email or code',
    short: 'Type 3 letters or more.',
    partialEmail: 'Type the full email.',
    code: 'Press Enter to look up this code.',
    none: 'No matches',
    noneLine: 'Check the spelling, or use the full email.',
    rateLimited: 'Too many lookups. Try again in {seconds} s.',
    offline: 'Look up needs a connection.',
  },
  direction: { in: 'In', out: 'Out', auto: 'Auto' },
  /** The mode a device scans in. */
  mode: { door: 'Door', desk: 'Desk', manager: 'Manager', operator: 'Operator' },
  offline: {
    strip: 'Offline. Reconnect to check scans.',
    stripSaving: 'Offline. Saving scans.',
    saved: '{n} waiting to sync',
  },
  sessionPaused: { line: 'Paused by a manager. Ask them to resume.', check: 'Check again' },
  sessionEnded: { title: 'Session ended', line: 'Ask a manager to open a new session.' },
  changeMode: {
    menu: 'Change mode',
    title: 'Change mode',
    customerSub: 'Scanning stops until staff switch back.',
    adminNote: 'Desk and Operator are set by an admin in Scanning.',
  },
  /** Why a desk let someone in. */
  overrideNotes: {
    forgot_out: 'Forgot to tap out',
    known: 'Known to staff',
    paid: 'Paid',
    other: 'Other',
  },
  overrideWhy: 'Why?',
  /** A locked item or an amount over max offers this; the sheet takes a Manager's PIN with no name. */
  managerCode: {
    action: 'Use manager code',
    title: 'Manager code',
    verb: '{action} needs a manager.',
    /** Under Approvals: Desk staff too. */
    titleDesk: 'Approval code',
    verbDesk: '{action} needs a manager or desk lead.',
    approver: 'Approver',
    field: '6-digit code',
    continue: 'Continue',
    wrong: 'Wrong code. {n} tries left.',
    locked: 'Too many tries. Try again in {wait}.',
  },
  /** The session is active but outside its hours. */
  closed: {
    headline: 'Closed',
    opens: 'Opens {when}.',
    noOpening: 'No opening set.',
    check: 'Check again',
    openNow: 'Open now',
    openNowTitle: 'Open early',
    alreadyOpen: 'Already open.',
    managerOnly: 'Only a manager can open early.',
    failed: 'Could not open. Try again.',
  },
  undo: {
    undone: '{action} undone',
    tooLate: 'Too late to undo here. An admin can fix it.',
    changed: 'The pass changed since. An admin can fix it.',
  },
} as const;
