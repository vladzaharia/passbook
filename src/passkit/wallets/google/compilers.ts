/**
 * The Google compiler: picks the type (architecture 3.1), falls back to Generic when the type's
 * required roles are missing, and exposes the five typed compilers underneath.
 */
import type { CompileResult, WalletCompiler, WalletPassView } from '../types.ts';
import type { GoogleCompiler } from './compile.ts';
import { googleEventCompiler } from './event.ts';
import { googleGenericCompiler } from './generic.ts';
import { googleGiftCompiler } from './gift.ts';
import { COMPILER_REVISION } from './limits.ts';
import { googleLoyaltyCompiler } from './loyalty.ts';
import { googleOfferCompiler } from './offer.ts';
import type { GoogleType } from './types.ts';

export const GOOGLE_COMPILERS: Record<GoogleType, GoogleCompiler> = {
  generic: googleGenericCompiler,
  event: googleEventCompiler,
  loyalty: googleLoyaltyCompiler,
  gift: googleGiftCompiler,
  offer: googleOfferCompiler,
};

const TYPE_NAME: Record<GoogleType, string> = {
  generic: 'Generic',
  event: 'Event ticket',
  loyalty: 'Loyalty',
  gift: 'Gift card',
  offer: 'Offer',
};

/** The type the Apple style asks for, before an author override (architecture 3.1). */
export function defaultType(view: WalletPassView): GoogleType {
  const { roles } = view;
  switch (view.style) {
    case 'eventTicket':
      return 'event';
    case 'storeCard':
      return (roles.balance || roles.giftCardNumber) && !roles.memberId && !roles.points
        ? 'gift'
        : 'loyalty';
    case 'coupon':
      return 'offer';
    default:
      return 'generic';
  }
}

export const googleCompiler: WalletCompiler = {
  target: 'google',
  revision: COMPILER_REVISION,
  compile(view, options): CompileResult {
    const configured = view.wallets?.google?.type;
    if (configured === 'off') return { type: 'off', items: [] };
    const wanted = configured ?? defaultType(view);
    const required = view.wallets?.required ?? [];
    const empty = required.find(
      (id) => id.startsWith('role.') && !view.roles[id.slice(5) as never],
    );
    if (empty)
      return {
        type: wanted,
        items: [],
        blocked: { code: 'REQUIRED_ROLE_EMPTY', message: `${empty} has no value.` },
      };

    const result = GOOGLE_COMPILERS[wanted].compile(view, options);
    if (result.blocked?.code !== 'TYPE_UNSATISFIED' || wanted === 'generic') return result;

    const message = `${TYPE_NAME[wanted]} not used: ${result.blocked.message}`;
    if (required.includes('type'))
      return { type: wanted, items: [], blocked: { code: 'TYPE_UNSATISFIED', message } };
    const fallback = GOOGLE_COMPILERS.generic.compile(view, options);
    return {
      ...fallback,
      items: [...fallback.items, { capability: 'type', path: '', support: 'omitted', message }],
    };
  },
};
