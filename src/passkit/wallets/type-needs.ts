/**
 * What each wallet type needs before it is used (architecture 3.1). The compilers keep their own
 * checks; this table only names the needs so the designer can show them, and `type-needs.test.ts`
 * fails when the two drift.
 */
import { MIN_LOGO } from './google/limits.ts';
import type { ViewImageFile, WalletPassView, WalletRole } from './types.ts';

export type WalletTypeTarget = 'google' | 'samsung';

export interface ImageNeed {
  kind: 'image';
  /** The `wallets.<target>.images` slot that overrides the Apple art. */
  slot: 'logo' | 'main';
  /** Apple slots the compilers fall back to, in order. */
  apple: readonly string[];
  /** The smallest the wallet takes, when it says. */
  min?: { width: number; height: number };
}

/** A need is a role, an image or the code a reservation number can come from. */
export type TypeNeed = { kind: 'role'; role: WalletRole } | ImageNeed | { kind: 'reservation' };

const role = (r: WalletRole): TypeNeed => ({ kind: 'role', role: r });
const GOOGLE_LOGO: ImageNeed = {
  kind: 'image',
  slot: 'logo',
  apple: ['icon', 'logo'],
  min: MIN_LOGO,
};
const logo = (apple: readonly string[]): ImageNeed => ({ kind: 'image', slot: 'logo', apple });
const main = (apple: readonly string[]): ImageNeed => ({ kind: 'image', slot: 'main', apple });

export const TYPE_NEEDS: Record<WalletTypeTarget, Record<string, readonly TypeNeed[]>> = {
  google: {
    generic: [],
    loyalty: [GOOGLE_LOGO],
    event: [role('eventName'), role('eventStart')],
    gift: [GOOGLE_LOGO, role('giftCardNumber')],
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
      logo(['logo', 'primaryLogo']),
      main(['artwork', 'strip', 'background']),
    ],
    coupon: [main(['strip', 'artwork', 'background']), role('validUntil')],
  },
};

const usable = (f: ViewImageFile): boolean =>
  !f.personal && f.url !== undefined && f.locale === undefined;

const fits = (f: ViewImageFile, min: ImageNeed['min']): boolean =>
  !min ||
  ((f.width === undefined || f.width >= min.width) &&
    (f.height === undefined || f.height >= min.height));

function hasImage(view: WalletPassView, target: WalletTypeTarget, need: ImageNeed): boolean {
  const own = view.images.overrides[target]?.[need.slot];
  // Google reads the author's file alone when there is one; Samsung falls back when it is unusable.
  if (own && (target === 'google' || usable(own))) return usable(own) && fits(own, need.min);
  return need.apple.some((s) => {
    const best = view.images.apple[s]?.find(usable);
    return best !== undefined && fits(best, need.min);
  });
}

function met(view: WalletPassView, target: WalletTypeTarget, need: TypeNeed): boolean {
  if (need.kind === 'image') return hasImage(view, target, need);
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
  return (TYPE_NEEDS[target][type] ?? []).filter((need) => !met(view, target, need));
}
