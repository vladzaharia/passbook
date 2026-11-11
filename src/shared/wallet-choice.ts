import type { WalletProvider, WalletProviderIssuance } from './contracts/wallet-providers.ts';
import { canAddToWallet, type DeviceInfo } from './device.ts';

/** Every way to get a pass into a wallet or onto a screen. */
export type WalletChoiceId = 'apple' | 'browser' | WalletProvider;

export interface WalletChoice {
  id: WalletChoiceId;
  /** Set for browser and native providers; Apple's links are built by the page. */
  href: string | null;
  /** The first choice, which fits this device best. */
  recommended: boolean;
}

export interface WalletChoiceInput {
  device: DeviceInfo;
  /** The pass can be added to Apple Wallet. */
  apple: boolean;
  /** The pass's browser barcode page, when it may be shown. */
  browserHref?: string | undefined;
  /** Native offers the server lists for this pass. */
  offers?: readonly { provider: WalletProvider; href: string }[];
  /** The server's release gate per provider; a disabled provider is never offered. */
  issuance?: Partial<Record<WalletProvider, WalletProviderIssuance>>;
}

/** Display names and badge art of the native providers (the pass page, the portal, the email). */
export const NATIVE_WALLET_BADGES: Record<
  WalletProvider,
  { label: string; path: string; width: number; height: number }
> = {
  google: {
    label: 'Add to Google Wallet',
    path: '/icons/wallet-providers/google/add-to-google-wallet.svg',
    width: 283,
    height: 50,
  },
  samsung: {
    label: 'Add to Samsung Wallet',
    path: '/icons/wallet-providers/samsung/add-to-samsung-wallet.png',
    width: 242,
    height: 50,
  },
};

/**
 * Which ways a holder has, best first. Device detection only orders: Apple leads on an iPhone or
 * Mac, the browser barcode leads elsewhere with Apple still listed. A provider's offer is dropped
 * only when its issuance is disabled. A later track adds Android's preference here.
 */
export function walletChoices(input: WalletChoiceInput): WalletChoice[] {
  const native = (input.offers ?? []).filter(
    (offer) => input.issuance?.[offer.provider]?.state !== 'disabled',
  );
  const all: Omit<WalletChoice, 'recommended'>[] = [
    ...(input.apple ? [{ id: 'apple' as const, href: null }] : []),
    ...(input.browserHref ? [{ id: 'browser' as const, href: input.browserHref }] : []),
    ...native.map((offer) => ({ id: offer.provider, href: offer.href })),
  ];
  const lead: WalletChoiceId = canAddToWallet(input.device.device) ? 'apple' : 'browser';
  const ordered = [...all.filter((c) => c.id === lead), ...all.filter((c) => c.id !== lead)];
  return ordered.map((choice, index) => ({ ...choice, recommended: index === 0 }));
}
