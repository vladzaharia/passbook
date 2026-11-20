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
  badge: 'Preview',
  approximate: '{wallet} draws the real card.',
  notShown: 'Not shown',
  different: 'Shown differently',
  allShown: 'Everything shows.',
  chosen: 'Left out by you',
  walletOff: '{wallet} is off for this template.',
  blocked: '{wallet} cannot show this pass.',
  loading: 'Loading preview',
  failed: 'This preview cannot be built. See the issues.',
  sampleValues: 'Sample values. Each pass shows its own.',
  mobileLine: 'The page a holder opens on their phone.',
  mobileFrame: 'Mobile ticket preview',
  allPreviews: 'All previews',
  offTitle: 'Off for this pass',
  nothing: 'No channel is on. This pass cannot be used.',
} as const;

export const walletName = (target: 'google' | 'samsung'): string =>
  target === 'google' ? 'Google Wallet' : 'Samsung Wallet';
