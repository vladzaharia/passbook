import type { ScanReason } from '../contracts/scan.ts';

/** Reasons that only the client makes: they never reach the wire. */
export type ClientScanReason =
  | 'network'
  | 'timeout'
  | 'unconfirmed'
  | 'still_unconfirmed'
  | 'server'
  | 'rate_limited'
  | 'saved_offline'
  | 'add_link';

export interface ScanLine {
  headline: string;
  /** `{name}` marks a value; fill it with `scanLine`. */
  sub: string;
}

/** Every verdict line of the scanner. `/scan`, the admin pages and the CSV read this one file. */
export const SCAN_REASON_COPY: Record<ScanReason | ClientScanReason, ScanLine> = {
  not_found: { headline: 'Not found', sub: "This code isn't a pass here." },
  ambiguous: { headline: 'More than one match', sub: 'Look it up by name instead.' },
  test_pass: { headline: 'Test pass', sub: "Live scanners don't take test passes." },
  live_pass: { headline: 'Live pass', sub: 'This is a test scanner.' },
  not_accepted: { headline: 'Not accepted here', sub: "{template} isn't on this scanner." },
  wrong_event: { headline: 'Wrong event', sub: 'For {event}.' },
  removed: { headline: 'Removed', sub: 'Removed {date}.' },
  voided: { headline: 'Voided', sub: 'Voided {date}.' },
  expired: { headline: 'Expired', sub: 'Ended {date}.' },
  no_balance: { headline: 'Not enough {unit}', sub: 'Has {have}, needs {need}.' },
  managed_elsewhere: {
    headline: 'Set by a connection',
    sub: '{input} come from {source}. Change them there.',
  },
  limit_reached: {
    headline: 'Daily limit reached',
    sub: "This scanner's limit resets at midnight.",
  },
  zone_not_included: { headline: 'Not in plan', sub: "{plan} doesn't include {zone}." },
  outside_hours: { headline: 'Outside hours', sub: '{plan} opens {when}.' },
  guest_expired: { headline: 'Guest pass ended', sub: 'Ended {time}.' },
  guest_visits_used: { headline: 'No visits left', sub: 'Used {limit} of {limit}.' },
  suspended: { headline: 'Suspended', sub: 'Ask them to see the front desk.' },
  already_done: { headline: 'Already checked in', sub: '{ago} · {scanner}' },
  cooldown: { headline: '{verb} {ago}', sub: 'Next {noun} in {wait}.' },
  not_yet_valid: { headline: 'Not open yet', sub: 'Opens {time}.' },
  ended: { headline: 'Event ended', sub: 'Ended {time}.' },
  capacity_full: { headline: 'Event full', sub: '{in} of {capacity} in.' },
  check_required: { headline: '{flag}', sub: 'Then check them in.' },
  needs_approval: { headline: 'Needs a manager', sub: '{action} is for managers.' },
  stale: { headline: '{input} changed', sub: 'Now {value}. Check it and set again.' },
  in_progress: {
    headline: 'Being scanned',
    sub: 'Another scanner has this pass. Scan again in a moment.',
  },
  choose: { headline: 'Choose an action', sub: 'Pick what to do with this pass.' },
  network: { headline: 'No connection', sub: "Scan again. It won't count twice." },
  timeout: { headline: 'No answer', sub: "Scan again. It won't count twice." },
  unconfirmed: { headline: 'Not confirmed', sub: "Checking again when you're back online." },
  still_unconfirmed: { headline: 'Still not confirmed', sub: 'Check Recent before trying again.' },
  server: { headline: 'Something went wrong', sub: 'Scan again.' },
  rate_limited: { headline: 'Too many scans', sub: 'Try again in {seconds} s.' },
  saved_offline: { headline: 'Checked in', sub: 'Saved offline' },
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
  changedElsewhere: 'Changed elsewhere',
  noPhoto: 'No photo',
  lowBalance: 'Low balance',
  noVisits: 'No visits yet.',
  /** The editor marks a row the render-time budget would drop. */
  cutOnThisScreen: 'Cut on this screen',
} as const;

export const SCAN_COPY = {
  reasons: SCAN_REASON_COPY,
  display: SCAN_DISPLAY_COPY,
  verdict: {
    checkedIn: 'Checked in',
    checkedOut: 'Checked out',
    redeemed: 'Redeemed',
    /** An Access card's check-in. The sub joins the zone and the closing time that exist. */
    access: {
      headline: 'Access granted',
      sub: '{zone} · until {time}',
      noHours: '{plan} has no hours this week.',
    },
    letInAgain: 'Let in again.',
    stamps: { one: '+{n} stamp', other: '+{n} stamps' },
    balanceSet: '{input} set',
  },
  actions: {
    done: 'Done',
    letInAgain: 'Let in again',
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
    pairAgain: 'Pair again',
    reload: 'Reload',
    endShift: 'End shift',
    startNewShift: 'Start new shift',
    unpair: 'Unpair',
  },
  boot: {
    pairTitle: 'Pair this device',
    pairLine: 'Scan the code in Scanning, or type it.',
    pairLabel: 'Pairing code',
    pairFooter: 'Admins make codes in Scanning.',
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
    pinLocked: 'Too many tries. Try again in 5 min.',
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
  undo: {
    undone: '{action} undone',
    tooLate: 'Too late to undo here. An admin can fix it.',
    changed: 'The pass changed since. An admin can fix it.',
  },
} as const;
