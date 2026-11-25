import type { Channel } from '../contracts/channels.ts';

export type PreviewChannel = Exclude<Channel, 'nfc'>;

/** The channel names as the switcher shows them. */
export const PREVIEW_LABEL: Record<PreviewChannel, string> = {
  apple: 'Apple',
  google: 'Google',
  samsung: 'Samsung',
  mobile: 'Mobile',
  paper: 'Paper',
};

/** `{wallet}` is "Google Wallet" or "Samsung Wallet". */
export const PREVIEW_COPY = {
  switcher: 'Channel',
  notShown: 'Not shown',
  different: 'Shown differently',
  allShown: 'Everything shows.',
  chosen: 'Left out by you',
  walletOff: '{wallet} is off for this template.',
  blocked: '{wallet} cannot show this pass.',
  loading: 'Loading preview',
  failed: 'This preview cannot be built. See the issues.',
  sampleValues: 'Sample values. Each pass shows its own.',
  mobileFrame: 'Mobile ticket preview',
  allPreviews: 'All previews',
  off: 'Off',
  nothing: 'No channel is on',
} as const;

export const walletName = (target: 'google' | 'samsung'): string =>
  target === 'google' ? 'Google Wallet' : 'Samsung Wallet';
