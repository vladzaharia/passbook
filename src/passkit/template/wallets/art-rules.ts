/** Per-target art rules: upload-time checks and the size a derived copy is cut to. Pure. */

export type WalletTarget = 'google' | 'samsung';

export interface ArtRule {
  minWidth: number;
  minHeight: number;
  /** Required aspect ratio [w, h]; the derived copy is cropped to it. */
  ratio?: [number, number];
  /** Derived width cap. With `outHeight` the copy is cropped to exactly this size. */
  outWidth: number;
  outHeight?: number;
  maxBytes?: number;
}

const KB = 1024;

/** google-wallet.md section 4 and samsung-wallet.md section 2 (image rules). Unlisted slots are unchecked. */
export const WALLET_ART_RULES: Record<WalletTarget, Record<string, ArtRule>> = {
  google: {
    logo: { minWidth: 660, minHeight: 660, ratio: [1, 1], outWidth: 660, outHeight: 660 },
    wideLogo: { minWidth: 1280, minHeight: 400, ratio: [16, 5], outWidth: 1280, outHeight: 400 },
    hero: { minWidth: 1032, minHeight: 1, outWidth: 1032 },
    mainImage: { minWidth: 1860, minHeight: 1, outWidth: 1860 },
  },
  samsung: {
    logo: { minWidth: 1, minHeight: 1, outWidth: 256, maxBytes: 256 * KB },
    main: { minWidth: 1, minHeight: 1, outWidth: 888, maxBytes: 512 * KB },
    cover: { minWidth: 1, minHeight: 1, outWidth: 888, maxBytes: 512 * KB },
    background: {
      minWidth: 888,
      minHeight: 555,
      ratio: [888, 555],
      outWidth: 888,
      outHeight: 555,
      maxBytes: 512 * KB,
    },
  },
};

export function artRule(target: WalletTarget, slot: string): ArtRule | undefined {
  return Object.hasOwn(WALLET_ART_RULES[target], slot) ? WALLET_ART_RULES[target][slot] : undefined;
}

/** `wallets/<target>/<slot>.png` -> its target and slot name. */
export function walletArtSlot(path: string): { target: WalletTarget; slot: string } | null {
  const match = /^wallets\/(google|samsung)\/([^/]+)\.png$/.exec(path);
  return match ? { target: match[1] as WalletTarget, slot: match[2] as string } : null;
}

const RATIO_TOLERANCE = 0.01;

/** The first rule the file breaks, or null (also for slots without a rule). */
export function checkWalletArt(
  path: string,
  bytes: number,
  width: number,
  height: number,
): string | null {
  const named = walletArtSlot(path);
  const rule = named && artRule(named.target, named.slot);
  if (!rule) return null;
  if (rule.maxBytes !== undefined && bytes > rule.maxBytes)
    return `${path} is over ${rule.maxBytes / KB} KB.`;
  if (width < rule.minWidth || height < rule.minHeight)
    return `${path} is ${width}x${height}; the minimum is ${rule.minWidth}x${rule.minHeight}.`;
  if (rule.ratio) {
    const [rw, rh] = rule.ratio;
    if (Math.abs(width * rh - height * rw) > RATIO_TOLERANCE * height * rw)
      return `${path} must be ${rw}:${rh}.`;
  }
  return null;
}

export interface ArtOutput {
  width: number;
  height: number;
  /** True: crop to the exact size; false: downscale keeping the aspect. */
  crop: boolean;
}

/** The size to cut a source to, never larger than the source. Null: the source is below the minimum. */
export function artOutput(rule: ArtRule, srcWidth: number, srcHeight: number): ArtOutput | null {
  if (srcWidth < rule.minWidth || srcHeight < rule.minHeight) return null;
  if (rule.ratio) {
    const [rw, rh] = rule.ratio;
    let width = Math.min(srcWidth, Math.floor((srcHeight * rw) / rh));
    if (width < rule.minWidth) return null;
    let height = Math.round((width * rh) / rw);
    if (rule.outHeight !== undefined && width > rule.outWidth) {
      width = rule.outWidth;
      height = rule.outHeight;
    }
    return { width, height, crop: true };
  }
  const width = Math.min(srcWidth, rule.outWidth);
  return { width, height: Math.round((srcHeight * width) / srcWidth), crop: false };
}
