import type { WalletProvider, WalletProviderIssuance } from './contracts/wallet-providers.ts';
import { type DeviceInfo, isAndroid, type PassDevice } from './device.ts';

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
  { label: string; path: string; emailPath: string; width: number; height: number }
> = {
  google: {
    label: 'Add to Google Wallet',
    path: '/icons/wallet-providers/google/add-to-google-wallet.svg',
    /** Gmail and Outlook do not draw SVG: email links the PNG of the same official artwork (3x). */
    emailPath: '/icons/wallet-providers/google/add-to-google-wallet.png',
    width: 283,
    height: 50,
  },
  samsung: {
    label: 'Add to Samsung Wallet',
    path: '/icons/wallet-providers/samsung/add-to-samsung-wallet.png',
    emailPath: '/icons/wallet-providers/samsung/add-to-samsung-wallet.png',
    width: 242,
    height: 50,
  },
};

/** What leads per device: the wallet that adds here, else the browser barcode. */
const LEAD: Record<PassDevice, readonly WalletChoiceId[]> = {
  iphone: ['apple'],
  mac: ['apple'],
  galaxy: ['samsung', 'google', 'browser'],
  android: ['google', 'browser'],
  other: ['browser'],
};

/**
 * Which ways a holder has, best first. Device detection only orders: Apple leads on an iPhone or
 * Mac, Samsung then Google on a Galaxy, Google on other Android, the browser barcode elsewhere,
 * the rest after. A provider's offer is dropped only when its issuance is disabled, so a Galaxy
 * holder never sees Samsung while it is dark.
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
  // Apple cannot add on Android: it stays reachable as the last, text-only way.
  const lead = LEAD[input.device.device];
  const rank = (c: { id: WalletChoiceId }) =>
    isAndroid(input.device.device) && c.id === 'apple'
      ? 2000
      : lead.includes(c.id)
        ? lead.indexOf(c.id)
        : 1000;
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  return ordered.map((choice, index) => ({ ...choice, recommended: index === 0 }));
}
