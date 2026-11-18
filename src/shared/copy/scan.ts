import type { ScanReason } from '../contracts/scan.ts';
import { SCAN_TAG_COPY } from './scan-tags.ts';

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
  not_found: { headline: 'Not found', sub: "This code isn't a pass here. Look it up by name." },
  ambiguous: { headline: 'More than one match', sub: 'Look it up by name instead.' },
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
  expired: { headline: 'Expired', sub: 'Ended {date}. Ask for a new pass.' },
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
  guest_visits_used: { headline: 'No visits left', sub: 'Used {used} of {limit} visits.' },
  suspended: { headline: 'Suspended', sub: 'Ask a manager.' },
  tag_lost: { headline: 'Tag reported lost', sub: 'Keep it and call security.' },
  tag_not_allowed: { headline: 'Tag not accepted', sub: "This tag isn't accepted here." },
  tag_invalid: { headline: "Tag couldn't be checked", sub: 'Try again or use the card.' },
  already_done: { headline: 'Already {done}', sub: '{ago} at {scanner}. Check ID.' },
  cooldown: { headline: 'Just done', sub: '{action} at {time}. Next in {wait}.' },
  not_yet_valid: { headline: 'Not open yet', sub: 'Opens {day} {time}.' },
  ended: { headline: '{place} ended', sub: 'Ended {time}.' },
  capacity_full: { headline: '{place} full', sub: '{in} of {capacity} in.' },
  check_required: { headline: '{flag}', sub: 'Check it, then tap {action}.' },
  needs_approval: { headline: 'Needs a manager', sub: '{action} is for managers.' },
  stale: { headline: '{input} changed', sub: 'Now {value}. Check it and set again.' },
  in_progress: {
    headline: 'Being scanned',
    sub: 'Another scanner has this pass. Scan again in a moment.',
  },
  still_inside: { headline: 'Already in', sub: 'Since {time} · {scanner}' },
  not_inside: { headline: 'Not tapped in', sub: 'No entry recorded. Tap them in first.' },
  choose: { headline: 'Choose an action', sub: 'Pick what to do with this pass.' },
  network: { headline: 'No connection', sub: 'Not checked. Hold them and scan again.' },
  timeout: { headline: 'No answer', sub: 'Not checked. Hold them and scan again.' },
  unconfirmed: { headline: 'Not confirmed', sub: "Checking again when you're back online." },
  still_unconfirmed: { headline: 'Still not confirmed', sub: 'Check Recent before trying again.' },
  server: { headline: 'Something went wrong', sub: 'Scan again.' },
  rate_limited: { headline: 'Too many scans', sub: 'Try again in {seconds} s.' },
  saved_offline: { headline: '{action}', sub: 'Saved offline' },
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

/** Refusal sub-lines for a reason whose plan has nothing to say. They never ride a grant. */
export const SCAN_REASON_VARIANTS = {
  outside_hours: { noHours: '{plan} has no hours this week. Ask a manager.' },
  zone_not_included: { noZone: '{plan} opens no zone here. Ask a manager.' },
  needs_approval: {
    headline: 'Needs a manager or desk lead',
    sub: '{action} needs approval.',
  },
  already_done: { noPrevious: 'Scanned earlier. Check ID.' },
  wrong_event: { noEvent: 'This scanner is for a different event.' },
  not_yet_valid: { noWhen: 'Not open yet. Try again later.' },
  capacity_full: { noPlace: 'Full', noCapacity: '{in} in.', noCount: 'At capacity.' },
  ended: { noPlace: 'Ended' },
} as const;

/** In/out lines that replace a reason's default when the place is a zone or the state is known. */
export const SCAN_OCCUPANCY_COPY: Record<string, ScanLine> = {
  zoneFull: { headline: '{zone} full', sub: '{in} of {capacity} in.' },
  eventStillIn: { headline: 'Already checked in', sub: 'Since {time} · {scanner}' },
  stillInRecent: { headline: 'Already in', sub: '{ago} · {scanner}' },
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
  reasons: SCAN_REASON_COPY,
  display: SCAN_DISPLAY_COPY,
  tags: SCAN_TAG_COPY,
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
  undo: {
    undone: '{action} undone',
    tooLate: 'Too late to undo here. An admin can fix it.',
    changed: 'The pass changed since. An admin can fix it.',
  },
} as const;
