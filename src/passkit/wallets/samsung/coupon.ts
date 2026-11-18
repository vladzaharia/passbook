/** `coupon/others`: needs a main image and an expiry. */

import type { WalletPassView, WalletRole } from '../types.ts';
import { finishCard, firstText } from './card.ts';
import { setAppLink, setBarcode, setContacts, setLocations } from './code.ts';
import { note, type Run, setDisplay } from './context.ts';
import { eventWindow } from './dates.ts';
import { epochText } from './format.ts';
import { pickImage, setColors, setImage } from './media.ts';

const COUPON_NATIVE: ReadonlySet<WalletRole> = new Set<WalletRole>([
  'title',
  'offerTitle',
  'eventStart',
  'validFrom',
  'validUntil',
  'appLink',
  'support',
]);

const mainImage = (view: WalletPassView) =>
  pickImage(view, 'main', ['strip', 'artwork', 'background']);

/** What a coupon needs that this pass lacks, or undefined. */
export function couponUnmet(view: WalletPassView): string | undefined {
  const missing = [
    !mainImage(view) && 'a main image',
    view.roles.validUntil?.kind !== 'date' && 'an expiry date',
  ].filter(Boolean);
  return missing.length > 0 ? missing.join(' and ') : undefined;
}

export function buildCoupon(run: Run): void {
  const { view, opts } = run;
  const used = new Set<string>();
  setDisplay(run, 'title', firstText(run, 'offerTitle', 'title'));
  const appLink = setAppLink(run);
  const main = mainImage(view);
  if (main) used.add(main.slot);
  setImage(run, 'mainImg', main, 'image.strip');
  const logo = pickImage(view, 'logo', ['logo', 'primaryLogo']);
  if (logo) note(run, 'image.logo', logo.slot, 'omitted', 'Samsung coupons have no logo.');
  setColors(run);

  const expiry = view.roles.validUntil;
  if (expiry?.kind === 'date') run.attrs.expiry = epochText(expiry.iso) ?? '';
  const window = eventWindow(run, ['eventStart', 'validFrom'], [], false);
  const issued = epochText(window.start) ?? String((opts.issuedAt ?? opts.now).getTime());
  run.attrs.issueDate = issued;
  Object.assign(run.attrs, {
    editableYn: 'N',
    deletableYn: 'Y',
    displayRedeemButtonYn: 'N',
    notificationYn: 'Y',
  });

  const serial = setBarcode(run);
  setLocations(run);
  const contacts = setContacts(run);
  finishCard(run, { native: COUPON_NATIVE, usedImages: used, serial, contacts, appLink });
}
