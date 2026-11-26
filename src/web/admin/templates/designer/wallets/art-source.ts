/** What a wallet's image slot uses now, read from the view the compilers read. */
import { type ArtRule, artRule } from '@/passkit/template/wallets/art-rules.ts';
import type { CompileResult, ViewImageFile, WalletPassView } from '@/passkit/wallets/types.ts';
import { GOOGLE_IMAGE_SLOTS, SAMSUNG_IMAGE_SLOTS } from '@/passkit/wallets/vocab.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import type { WalletName } from './roles-model.ts';

export const SLOTS: Record<WalletName, readonly string[]> = {
  google: GOOGLE_IMAGE_SLOTS,
  samsung: SAMSUNG_IMAGE_SLOTS,
};

/** The Apple slots a wallet slot falls back to, in the compilers' order. */
const FALLBACK: Record<WalletName, Record<string, readonly string[]>> = {
  google: {
    logo: ['logo', 'icon'],
    hero: ['strip', 'artwork', 'background'],
    thumbnail: ['thumbnail'],
  },
  samsung: {
    logo: ['logo', 'primaryLogo'],
    main: ['strip', 'artwork', 'background'],
    background: ['background'],
  },
};

const CAPABILITY: Record<string, string> = {
  logo: 'image.logo',
  hero: 'image.strip',
  thumbnail: 'image.thumbnail',
  main: 'image.strip',
  background: 'image.background',
};

/** `1032 × 396` and the like, from the rule. */
export function ruleLine(rule: ArtRule | undefined): string | null {
  if (!rule) return null;
  const C = WALLETS_COPY.images;
  const parts: string[] = [];
  if (rule.ratio && rule.outHeight !== undefined)
    parts.push(
      rule.ratio[0] === rule.ratio[1]
        ? `${C.min.replace('{w}', String(rule.minWidth)).replace('{h}', String(rule.minHeight))}, ${C.square}`
        : C.exact.replace('{w}', String(rule.outWidth)).replace('{h}', String(rule.outHeight)),
    );
  else if (rule.minWidth > 1) parts.push(C.wide.replace('{w}', String(rule.minWidth)));
  if (rule.maxBytes) parts.push(C.under.replace('{kb}', String(rule.maxBytes / 1024)));
  return parts.length > 0 ? `${parts.join(', ')}.` : null;
}

export interface SlotState {
  slot: string;
  rule: ArtRule | undefined;
  /** The file the wallet uses now, or null. */
  file: ViewImageFile | null;
  /** Own art in `wallets/<target>/`, as opposed to the Apple art it falls back to. */
  own: boolean;
  /** What the compiler said about this slot's art, when it lost or changed it. */
  note: string | null;
}

export function slotStates(
  view: WalletPassView,
  compiled: CompileResult,
  target: WalletName,
): SlotState[] {
  return SLOTS[target].map((slot) => {
    const own = view.images.overrides[target]?.[slot] ?? null;
    const fallback = own
      ? null
      : (FALLBACK[target][slot] ?? [])
          .map((s) => view.images.apple[s]?.[0])
          .find((f): f is ViewImageFile => Boolean(f && !f.personal));
    const cap = CAPABILITY[slot];
    const item = compiled.items.find(
      (i) => i.capability === cap && (i.support === 'omitted' || i.support === 'difference'),
    );
    return {
      slot,
      rule: artRule(target, slot),
      file: own ?? fallback ?? null,
      own: Boolean(own),
      note: item?.message ?? null,
    };
  });
}
