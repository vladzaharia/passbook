import type { Channel, ChannelReason, ChannelSource, OfferHold } from '../contracts/channels.ts';
import { FEATURE_ASK, NOT_INCLUDED } from './entitlements.ts';

export const CHANNEL_LABEL: Record<Channel, string> = {
  mobile: 'Mobile',
  apple: 'Apple Wallet',
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
  paper: 'Paper',
  nfc: 'Linked NFC',
};

export const CHANNEL_STATE_LABEL = { on: 'On', off: 'Off', never: 'Never' } as const;

export const CHANNEL_SOURCE_LABEL = {
  pass: 'This pass',
  template: 'Template',
  org: 'Organization',
  platform: 'Platform',
} as const;

/** `{channel}` is a CHANNEL_LABEL. */
export const CHANNEL_REASON_COPY: Record<ChannelReason, string> = {
  not_released: '{channel}: not available yet',
  not_enrolled: '{channel}: organization not enrolled',
  no_design: '{channel}: no design for this template',
  tags_off: '{channel}: tags off',
  printing_off: '{channel}: printing off for all organizations',
  not_included: '{channel}: not included for this organization',
  blocked: '{channel}: blocked for this organization',
  never: '{channel}: never on for this template',
  template_off: '{channel}: off for this template',
  pass_off: '{channel}: off for this pass',
};

export const channelReason = (channel: Channel, reason: ChannelReason): string =>
  CHANNEL_REASON_COPY[reason].replace('{channel}', CHANNEL_LABEL[channel]);

/** The reason without the channel label, for a row that already shows it: "Organization not enrolled". */
export const channelReasonText = (reason: ChannelReason): string => {
  const text = CHANNEL_REASON_COPY[reason].replace('{channel}: ', '');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Only these can leave copies behind; a block of them never retires or replaces copies. */
const LEAVES_COPIES = new Set<ChannelReason>([
  'blocked',
  'not_enrolled',
  'tags_off',
  'not_included',
]);

/** A limit above the template, as a row's second line. */
export const channelBlocked = (reason: ChannelReason): string =>
  LEAVES_COPIES.has(reason)
    ? `${channelReasonText(reason)}. ${CHANNEL_COPY.copiesStay}`
    : channelReasonText(reason);

/** Where a limit is changed: a level, or the wallet accounts page for provider enrolment. */
export type ChannelFix = 'platform' | 'org' | 'template' | 'wallet';

const PROVIDER_ACCOUNT: Partial<Record<Channel, string>> = {
  google: 'Google account',
  samsung: 'Samsung account',
};

/**
 * Why a channel cannot be on, and where to fix it; null `fix` when nothing in the admin can. Tags the
 * platform turned off (`source: 'platform'`) are fixed in Platform settings, not the organization's.
 */
export const channelWhy = (
  channel: Channel,
  reason: ChannelReason,
  source?: ChannelSource,
): { text: string; fix: ChannelFix | null; copiesStay: boolean } => {
  switch (reason) {
    case 'not_released':
      return { text: 'Not released yet', fix: null, copiesStay: false };
    case 'not_enrolled':
      return {
        text: `Waiting for ${PROVIDER_ACCOUNT[channel] ?? 'account'}`,
        fix: 'wallet',
        copiesStay: true,
      };
    case 'no_design':
      return { text: 'No design in this template', fix: 'template', copiesStay: false };
    case 'tags_off':
      if (source === 'platform')
        return { text: 'Off for the platform', fix: 'platform', copiesStay: true };
      return { text: 'Off for this organization', fix: 'org', copiesStay: true };
    case 'blocked':
      return { text: 'Off for this organization', fix: 'org', copiesStay: true };
    case 'printing_off':
      return { text: 'Off for the platform', fix: 'platform', copiesStay: false };
    case 'not_included':
      return {
        text: `${NOT_INCLUDED} ${FEATURE_ASK}`,
        fix: null,
        copiesStay: true,
      };
    case 'never':
      return { text: 'Never for this template', fix: 'template', copiesStay: false };
    case 'template_off':
      return { text: 'Off for this template', fix: 'template', copiesStay: false };
    case 'pass_off':
      return { text: 'Off for this pass', fix: null, copiesStay: false };
  }
};

export const CHANNEL_FIX_LABEL: Record<ChannelFix, string> = {
  platform: 'Platform settings',
  org: 'Organization settings',
  template: 'Channels and brand',
  wallet: 'Wallet accounts',
};

export const CHANNEL_COPY = {
  useTemplate: 'Use template',
  notAvailable: 'Not available',
  disabled: 'Disabled',
  platformCard: 'Channels',
  appleTap: 'Apple phone tap',
  appleTapWaiting: 'Waiting for Apple approval',
  paperPlatform: 'Paper tickets for all organizations',
  tagsPlatform: 'NFC tags for all organizations',
  orgCard: 'Channels',
  orgNote: 'A blocked channel stops offering new copies. Copies stay as they are.',
  copiesStay: 'Copies stay as they are.',
  nothingOn: 'No channel is on. This pass cannot be used.',
  holderNotice: 'Your {channel} copy no longer works. Open {link}.',
  /** `{channel}` is a label; `{n}` a pass count. */
  turnsOff: 'Turns off {channel} for {n} passes.',
  card: 'Channels',
  copiesKeep: 'Copies keep working until New code.',
  /** `{n}` is a count. */
  clears: 'Clears {n} pass overrides.',
  clearsOne: 'Clears 1 pass override.',
  turnsOffOne: 'Turns off {channel} for 1 pass.',
  noChange: 'No passes change.',
  saved: 'Channels saved',
  turnOffTitle: 'Turn off {channel}?',
  turnOffPass: 'New copies stop. Copies keep working until New code.',
  turnOffPassPaper: 'The active print is voided.',
  bulkTitle: 'Channels',
  bulkNotify: 'Email holders when a copy stops working',
  turnsOffReplace: 'Turns off {channel} for {n} passes and issues new codes.',
  /** `{name}` is the event or session; `{time}` when it closes. */
  replaceWindowOpen: "Codes can't change while {name} is open. Try after {time}.",
  replaceWindowOpenNoEnd: "Codes can't change while {name} is open. Try again when it closes.",
  replaceAllOff: 'Keep one digital channel on to replace codes.',
  replaceBox: 'Also issue new codes',
  replaceNote: 'Holders get a new code. Printed tickets keep working.',
  turnsOffReplaceOne: 'Turns off {channel} for 1 pass and issues a new code.',
  /** `{name}` is the event or session; `{time}` when it opens. */
  replaceWindowSoon: '{name} opens {time}. Holders may get a new code just before.',
  replaceWindowNoHours: '{name} has no hours, so it may be in use.',
  /** `{name}` is the event or session; `{time}` when it ends. */
  runWaiting: 'Waiting for {name} to end',
  runWaitingUntil: 'Waiting for {name} to end, {time}',
  bulkWait: 'New codes wait until {name} ends.',
  bulkWaitUntil: 'New codes wait until {name} ends, {time}.',
  /** `{n}` is a pass count. */
  bulkUnsupported: '{n} passes turn off without a new code: their barcode is not the scan code.',
  bulkUnsupportedOne: '1 pass turns off without a new code: its barcode is not the scan code.',
  bulkAllOff: '{n} passes keep no digital channel on, so they get no new code.',
  bulkAllOffOne: '1 pass keeps no digital channel on, so it gets no new code.',
  runsTitle: 'Recent changes',
  runDropped: 'Replaced by a later save',
  runPassesOne: '1 pass changed',
  runPasses: '{n} passes changed',
  runRotated: '{n} new codes',
  runPrincipalRevoked: 'Codes were not replaced: you no longer can publish.',
  runWindowTimeout: 'Codes were not replaced: an event or session stayed open for 48 hours.',
  runFailed: 'Could not apply. Save again.',
  bulkReplaced: 'New codes follow after any open event or session.',
  replaceUnsupported: "This template's barcode is not its scan code, so codes can't be replaced.",
  /** The holder is told when codes are replaced: email subject and heading, hosted page note. */
  codesReplacedTitle: 'Your code changed',
  codesReplaced: 'Open your ticket before you arrive.',
} as const;

/** `{channel}` is a CHANNEL_LABEL. */
export const OFFER_HOLD_COPY: Record<OfferHold, string> = {
  provider_retiring: '{channel}: the old copy is being removed. Try again shortly.',
  provider_epoch_limit: '{channel}: turned back on too many times. Ask for a new code.',
};

export const offerHold = (channel: Channel, hold: OfferHold): string =>
  OFFER_HOLD_COPY[hold].replace('{channel}', CHANNEL_LABEL[channel]);
