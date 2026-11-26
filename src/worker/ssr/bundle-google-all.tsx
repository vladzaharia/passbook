import { NATIVE_WALLET_BADGES } from '../../shared/wallet-choice.ts';

/** One Google Wallet badge per save link that adds every Google-offered pass of the bundle. */
export function GoogleAllLinks({ hrefs }: { hrefs: readonly string[] }) {
  return hrefs.map((href, index) => (
    <div key={href} className="wl-native-wallets">
      <a href={href}>
        <img
          src={NATIVE_WALLET_BADGES.google.path}
          alt={`${NATIVE_WALLET_BADGES.google.label}, all passes${hrefs.length > 1 ? ` (${index + 1})` : ''}`}
        />
      </a>
    </div>
  ));
}
