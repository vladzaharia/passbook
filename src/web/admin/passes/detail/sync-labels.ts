import type { PassEventDto } from '@/shared/contracts/events.ts';
import { REMOVAL_WALLET_NAME, type RemovalWallet } from '@/shared/copy/removal.ts';

/** Prefix on a device row made by a Test simulation. */
export const SIMULATED_DEVICE = 'Simulated';

/** One-line titles for events that stand alone in the sync log. */
export const SINGLE_TITLE: Record<string, string> = {
  'pass.voided': 'Voided',
  'pass.unvoided': 'Unvoided',
  'pass.link_rotated': 'Link rotated',
  'pass.channels_changed': 'Channels changed',
  'pass.printed': 'Printed',
  'pass.print_voided': 'Print voided',
  'pass.replaced': 'Replaced by a new pass',
  'email.queued': 'Email queued',
  'email.sent': 'Email sent',
  'email.failed': 'Email failed',
  'email.captured': 'Email captured in the Test inbox',
  'page.opened': 'Pass page opened',
  'pass.downloaded': '.pkpass downloaded',
  'bundle.opened': 'Bundle page opened',
  'bundle.downloaded': 'Bundle downloaded',
  'device.registered': 'Device added the pass',
  'device.unregistered': 'Stopped updates',
  'device.log': 'Wallet log line',
  'wallet.saved': 'Holder saved the pass',
  'wallet.removed': 'Holder removed the pass',
  'wallet.messaged': 'Wallet message',
  'push.sent': 'Push sent',
  'push.failed': 'Push failed',
  'push.queued': 'Push queued',
  'device.fetched': 'Device fetched the pass',
  'message.applied': 'Message applied',
  'schedule.applied': 'Scheduled change applied',
  'scan.checked_in': 'Checked in',
  'scan.checked_out': 'Tapped out',
  'scan.redeemed': 'Redeemed',
  'scan.adjusted': 'Balance adjusted',
  'scan.rejected': 'Scan rejected',
};

const walletName = (provider: string) =>
  provider === 'samsung' ? 'Samsung Wallet' : 'Google Wallet';

/** Which wallet a provider report came from, or which wallets a removal reached. */
export function walletDetail(e: PassEventDto): string | null {
  if (e.kind === 'pass.removed' && Array.isArray(e.data.wallets))
    return e.data.wallets
      .flatMap((w) =>
        typeof w === 'string' && w in REMOVAL_WALLET_NAME
          ? [REMOVAL_WALLET_NAME[w as RemovalWallet]]
          : [],
      )
      .join(', ');
  const provider = e.data.provider;
  return e.kind.startsWith('wallet.') && typeof provider === 'string' ? walletName(provider) : null;
}

const MESSAGED_FACT: Record<string, { text: string; tone: 'info' | 'warning' }> = {
  notified: { text: 'Notified', tone: 'info' },
  text: { text: 'Daily limit reached', tone: 'warning' },
  // Samsung has no notifying call: the card changed and Samsung decides what the holder sees.
  updated: { text: 'Updated only', tone: 'info' },
  failed: { text: 'Not accepted', tone: 'warning' },
  unknown: { text: 'Not confirmed', tone: 'warning' },
};

/** What a wallet did with a message: told the holder, showed it on the card only, refused it, or never said. */
export function messagedFacts(
  data: PassEventDto['data'],
): { text: string; tone: 'info' | 'warning' }[] {
  const fact = typeof data.outcome === 'string' ? MESSAGED_FACT[data.outcome] : undefined;
  return fact ? [fact] : [];
}

/** A wallet whose own daily limit a message hit. */
export function budgetFacts(data: PassEventDto['data']): { text: string; tone: 'warning' }[] {
  const budget = data.providers;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return [];
  return Object.entries(budget)
    .filter(([, outcome]) => outcome === 'over')
    .map(([provider]) => ({
      text: `${walletName(provider)}: daily limit reached`,
      tone: 'warning',
    }));
}
