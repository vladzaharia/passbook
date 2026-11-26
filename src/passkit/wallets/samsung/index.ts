/**
 * The Samsung compiler (architecture 3 and 6.4): loyalty, ticket and coupon cards from the wallet
 * view. Pure. A `generic` or `giftcard` template compiles as `loyalty/others` with a `type`
 * omission until Samsung confirms updates for them (Q14).
 */
import type { CompileResult, WalletCompiler, WalletPassView } from '../types.ts';
import { newRun, note, type Run, type SamsungCompileOptions, type SamsungType } from './context.ts';
import { buildCoupon, couponUnmet } from './coupon.ts';
import type { SamsungCardData, SamsungState } from './envelope.ts';
import { buildLoyalty } from './loyalty.ts';
import { buildTicket, ticketSubType, ticketUnmet } from './ticket.ts';

export { SAMSUNG_CAPABILITIES } from './capabilities.ts';
export type { SamsungCompileOptions, SamsungType } from './context.ts';
export type { SamsungCardData, SamsungCardMeta, SamsungState } from './envelope.ts';
export { samsungCardBody } from './envelope.ts';
export { SAMSUNG_LIMITS } from './limits.ts';
export { samsungPortalUrl } from './portal.ts';

/** Joins the release candidate digest. Bump it with any change to compiled output. */
export const SAMSUNG_COMPILER_REVISION = 2;

type Wanted = SamsungType | 'generic' | 'giftcard';

/** The style's type (architecture 3.1), or the author's. */
export function wantedType(view: WalletPassView, configured: Wanted | 'off' | undefined): Wanted {
  if (configured && configured !== 'off') return configured;
  if (view.style === 'eventTicket') return 'ticket';
  if (view.style === 'coupon') return 'coupon';
  if (view.style === 'storeCard') {
    const { roles } = view;
    const gift = (roles.balance || roles.giftCardNumber) && !(roles.memberId || roles.points);
    return gift ? 'giftcard' : 'loyalty';
  }
  return 'generic';
}

function stateOf(view: WalletPassView): SamsungState {
  if (view.validity.voided) return 'CANCELED';
  return view.validity.expired ? 'EXPIRED' : 'ACTIVE';
}

const BUILD: Record<SamsungType, (run: Run) => void> = {
  loyalty: buildLoyalty,
  ticket: buildTicket,
  coupon: buildCoupon,
};
const LOCALIZED = ['title', 'noticeDesc'] as const;

function localizations(
  view: WalletPassView,
  opts: SamsungCompileOptions,
  type: SamsungType,
  language: string,
  base: Run,
) {
  const out: NonNullable<SamsungCardData['localization']> = [];
  for (const locale of Object.keys(view.localization).sort()) {
    const table = view.localization[locale];
    if (!table || locale === language) continue;
    const run = newRun(view, opts, type, (value) => table[value] ?? value);
    BUILD[type](run);
    const attributes = Object.fromEntries(
      LOCALIZED.flatMap((key) =>
        run.attrs[key] !== undefined && run.attrs[key] !== base.attrs[key]
          ? [[key, run.attrs[key]]]
          : [],
      ),
    );
    if (Object.keys(attributes).length > 0) out.push({ language: locale, attributes });
  }
  return out;
}

const sorted = <T extends Record<string, string>>(o: T): T =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;

function compile(view: WalletPassView, opts: SamsungCompileOptions): CompileResult {
  const config = view.wallets?.samsung;
  if (config?.type === 'off') return { type: 'off', items: [] };
  const wanted = wantedType(view, config?.type);
  const language = opts.language ?? 'en';

  let type: SamsungType = 'loyalty';
  let fallback: string | undefined;
  if (wanted === 'generic' || wanted === 'giftcard')
    fallback = `Samsung confirms updates for loyalty cards only, not ${wanted}. Compiled as loyalty.`;
  else {
    const unmet =
      wanted === 'ticket' ? ticketUnmet(view) : wanted === 'coupon' ? couponUnmet(view) : undefined;
    if (unmet) fallback = `A Samsung ${wanted} needs ${unmet}. Compiled as loyalty.`;
    else type = wanted;
  }

  const run = newRun(view, opts, type);
  if (fallback) {
    note(run, 'type', '', 'omitted', fallback);
    if (view.wallets?.required?.includes('type'))
      return { type, items: run.items, blocked: { code: 'TYPE_UNSATISFIED', message: fallback } };
  }
  const empty = (view.wallets?.required ?? []).find(
    (id) => id.startsWith('role.') && !view.roles[id.slice(5) as keyof typeof view.roles],
  );
  if (empty)
    return {
      type,
      items: run.items,
      blocked: {
        code: 'REQUIRED_ROLE_EMPTY',
        message: `The required role ${empty.slice(5)} is empty.`,
      },
    };

  BUILD[type](run);
  if (run.blocked) return { type, items: run.items, blocked: run.blocked };
  const localization = localizations(view, opts, type, language, run);
  const cardData: SamsungCardData = {
    type,
    subType: type === 'ticket' ? ticketSubType(view, config?.subType) : 'others',
    state: stateOf(view),
    language,
    attributes: sorted(run.attrs),
    ...(localization.length > 0 ? { localization } : {}),
  };
  return { type, items: run.items, cardData };
}

export const samsungCompiler: WalletCompiler = {
  target: 'samsung',
  revision: SAMSUNG_COMPILER_REVISION,
  compile,
};
