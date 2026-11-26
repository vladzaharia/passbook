/**
 * What each wallet type needs before it is used (architecture 3.1). The compilers keep their own
 * checks; this table only names the needs so the designer can show them, and `type-needs.test.ts`
 * fails when the two drift.
 */
import type { ViewImageFile, WalletPassView, WalletRole } from './types.ts';

export type WalletTypeTarget = 'google' | 'samsung';

/** A need is a role, an image or the code a reservation number can come from. */
export type TypeNeed =
  | { kind: 'role'; role: WalletRole }
  | { kind: 'image'; slot: 'logo' | 'main' }
  | { kind: 'reservation' };

const role = (r: WalletRole): TypeNeed => ({ kind: 'role', role: r });
const image = (slot: 'logo' | 'main'): TypeNeed => ({ kind: 'image', slot });

export const TYPE_NEEDS: Record<WalletTypeTarget, Record<string, readonly TypeNeed[]>> = {
  google: {
    generic: [],
    loyalty: [],
    event: [role('eventName'), role('eventStart')],
    gift: [role('giftCardNumber')],
    offer: [role('offerTitle'), role('redemptionChannel')],
  },
  samsung: {
    loyalty: [],
    generic: [],
    giftcard: [],
    ticket: [
      role('eventName'),
      role('eventStart'),
      { kind: 'reservation' },
      image('logo'),
      image('main'),
    ],
    coupon: [image('main'), role('validUntil')],
  },
};

const APPLE_SLOTS: Record<'logo' | 'main', Record<string, readonly string[]>> = {
  logo: { ticket: ['logo', 'primaryLogo'], coupon: ['logo', 'primaryLogo'] },
  main: { ticket: ['artwork', 'strip', 'background'], coupon: ['strip', 'artwork', 'background'] },
};

const usable = (f: ViewImageFile): boolean =>
  !f.personal && f.url !== undefined && f.locale === undefined;

function hasImage(view: WalletPassView, type: string, slot: 'logo' | 'main'): boolean {
  const own = view.images.overrides.samsung?.[slot];
  if (own && usable(own)) return true;
  return (APPLE_SLOTS[slot][type] ?? []).some((s) => view.images.apple[s]?.some(usable));
}

function met(view: WalletPassView, target: WalletTypeTarget, type: string, need: TypeNeed) {
  if (need.kind === 'image') return hasImage(view, type, need.slot);
  if (need.kind === 'reservation')
    return (
      view.roles.confirmationCode?.kind === 'text' ||
      view.roles.ticketNumber?.kind === 'text' ||
      view.barcodes.some((b) => b.kind !== 'other')
    );
  const value = view.roles[need.role];
  // Samsung reads dates as dates; Google only asks that the role has a value.
  return target === 'samsung' && (need.role === 'eventStart' || need.role === 'validUntil')
    ? value?.kind === 'date'
    : Boolean(value);
}

/** The needs of `type` this view does not meet, in table order. */
export function unmetNeeds(
  target: WalletTypeTarget,
  type: string,
  view: WalletPassView,
): TypeNeed[] {
  return (TYPE_NEEDS[target][type] ?? []).filter((need) => !met(view, target, type, need));
}

/** A stable id for a need: `role.eventName`, `image.logo`, `reservation`. */
export const needId = (need: TypeNeed): string =>
  need.kind === 'role'
    ? `role.${need.role}`
    : need.kind === 'image'
      ? `image.${need.slot}`
      : 'reservation';
