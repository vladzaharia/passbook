import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { distinguishingLine, normalize } from '../../../shared/pass-view/index.ts';
import { stateWordOption } from '../../../shared/state-word.ts';
import type { BundlePageItem } from '../../ssr/bundle-page.tsx';
import type { BundleMember } from './public-service.ts';
import { bundleWalletHref } from './wallet-links.ts';

/** The page's rows: every path is the bundle's own, so no pass link reaches the HTML. */
export function bundleItems(
  token: string,
  members: readonly BundleMember[],
  wallets: readonly (readonly WalletProvider[])[],
  page: { lang: string; now: Date; zone: string },
): BundlePageItem[] {
  return members.map(({ pass, model }, index) => {
    const view = normalize(model.passJson, {
      assets: model.assets,
      locale: page.lang,
      now: page.now,
      timeZone: page.zone,
      ...stateWordOption(pass),
    });
    const title = pass.displayTitle ?? view.description ?? model.orgName;
    return {
      id: pass.id,
      view,
      title,
      detail: distinguishingLine(model.passJson, title),
      state:
        pass.removedAt !== null
          ? 'removed'
          : pass.status === 'voided' || view.voided
            ? 'voided'
            : 'active',
      downloadHref: model.channels.effective.apple.on ? `/b/${token}/${pass.id}/pass.pkpass` : null,
      href: `/b/${token}/${pass.id}/open`,
      barcodeHref: model.channels.effective.mobile.on
        ? `/b/${token}/${pass.id}/barcode`
        : undefined,
      walletOffers: (wallets[index] ?? []).map((provider) => ({
        provider,
        href: bundleWalletHref(token, pass.id, provider),
      })),
    };
  });
}
