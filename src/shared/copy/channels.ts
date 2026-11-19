import type { Channel, ChannelReason } from '../contracts/channels.ts';

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
  tags_off: '{channel}: tags off for this organization',
  printing_off: '{channel}: printing off for all organizations',
  blocked: '{channel}: blocked for this organization',
  never: '{channel}: never on for this template',
  template_off: '{channel}: off for this template',
  pass_off: '{channel}: off for this pass',
};

export const channelReason = (channel: Channel, reason: ChannelReason): string =>
  CHANNEL_REASON_COPY[reason].replace('{channel}', CHANNEL_LABEL[channel]);

export const CHANNEL_COPY = {
  useTemplate: 'Use template',
  nothingOn: 'No channel is on. This pass cannot be used.',
  holderNotice: 'Your {channel} copy no longer works. Open {link}.',
  /** `{channel}` is a label; `{n}` a pass count. */
  turnsOff: 'Turns off {channel} for {n} passes.',
  turnsOffReplace: 'Turns off {channel} for {n} passes and issues new codes.',
} as const;
