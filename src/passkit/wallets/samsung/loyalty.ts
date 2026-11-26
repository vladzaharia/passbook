/** `loyalty/others`: the type Samsung confirms updates for, and where `generic` and `giftcard` land (Q14). */

import type { WalletRole } from '../types.ts';
import { finishCard, firstText } from './card.ts';
import { setAppLink, setBarcode, setContacts, setLocations } from './code.ts';
import { type Run, setDisplay } from './context.ts';
import { eventWindow, setWindow } from './dates.ts';
import { roleText } from './format.ts';
import { pickImage, setColors, setImage } from './media.ts';

export const LOYALTY_NATIVE: ReadonlySet<WalletRole> = new Set<WalletRole>([
  'title',
  'points',
  'pointsLabel',
  'balance',
  'eventStart',
  'eventEnd',
  'validFrom',
  'validUntil',
  'appLink',
  'support',
]);

/** The title role, unless the card already shows it as the balance or points: then the organization, as Google's. */
function cardTitle(run: Run): string {
  const { roles } = run.view;
  const title = roles.title ? roleText(roles.title).trim() : '';
  const shown = [roles.balance, roles.points].flatMap((r) => (r ? [roleText(r).trim()] : []));
  const fields = new Set([...(roles.balance?.fields ?? []), ...(roles.points?.fields ?? [])]);
  const repeats = shown.includes(title) || (roles.title?.fields ?? []).some((f) => fields.has(f));
  return repeats ? run.view.org : firstText(run, 'title');
}

export function buildLoyalty(run: Run): void {
  const { view } = run;
  const used = new Set<string>();
  setDisplay(run, 'title', cardTitle(run));
  setDisplay(run, 'providerName', view.org);
  const appLink = setAppLink(run);

  const logo = pickImage(view, 'logo', ['logo', 'primaryLogo']);
  if (logo) used.add(logo.slot);
  setImage(run, 'logoImage', logo, 'image.logo');
  const background = pickImage(view, 'background', ['background', 'artwork', 'strip']);
  if (background) used.add(background.slot);
  setImage(run, 'bgImage', background, 'image.background');
  setColors(run);

  setWindow(run, eventWindow(run, ['eventStart', 'validFrom'], ['validUntil', 'eventEnd']));

  const points = view.roles.points;
  if (points && (points.kind === 'number' || points.kind === 'text')) {
    const unit = view.roles.pointsLabel;
    const text = `${points.text}${unit?.kind === 'text' ? ` ${unit.text}` : ''}`;
    setDisplay(run, 'amount', run.tr(text));
  }
  const balance = view.roles.balance;
  if (balance?.kind === 'money')
    setDisplay(run, 'balance', `${balance.amount} ${balance.currencyCode}`);

  const serial = setBarcode(run);
  setLocations(run);
  const contacts = setContacts(run);
  finishCard(run, { native: LOYALTY_NATIVE, usedImages: used, serial, contacts, appLink });
}
