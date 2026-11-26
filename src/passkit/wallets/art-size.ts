import { artOutput, artRule, type WalletTarget } from '../template/wallets/art-rules.ts';
import type { ViewImageFile } from './types.ts';

/** The provider slot an Apple art slot is cut for; the same picks as `APPLE_ART_SLOT` in wallet-providers. */
const CUT_SLOT: Record<WalletTarget, Record<string, string>> = {
  google: {
    icon: 'logo',
    logo: 'logo',
    primaryLogo: 'logo',
    strip: 'hero',
    background: 'hero',
    artwork: 'hero',
  },
  samsung: {
    icon: 'logo',
    logo: 'logo',
    primaryLogo: 'logo',
    strip: 'background',
    background: 'background',
    artwork: 'background',
  },
};

const NAME: Record<WalletTarget, string> = { google: 'Google', samsung: 'Samsung' };

/**
 * Why a file of known size gets no address: it is too small or the wrong shape for the slot it is
 * cut for. Undefined when the size is unknown or fits (the address is missing for another reason).
 */
export function sizeReason(
  target: WalletTarget,
  slot: string,
  file: Pick<ViewImageFile, 'width' | 'height'>,
): string | undefined {
  const cut = CUT_SLOT[target][slot] ?? slot;
  const rule = artRule(target, cut);
  if (!rule || file.width === undefined || file.height === undefined) return undefined;
  if (artOutput(rule, file.width, file.height)) return undefined;
  const need =
    rule.minHeight > 1 ? `${rule.minWidth} x ${rule.minHeight}` : `${rule.minWidth} px wide`;
  const ratio = rule.ratio ? ` (${rule.ratio[0]}:${rule.ratio[1]})` : '';
  const slotName = cut === slot ? slot : `${slot} (${cut})`;
  return `The ${slotName} image is ${file.width} x ${file.height}; ${NAME[target]} needs ${need}${ratio}. Replace it.`;
}
