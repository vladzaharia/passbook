/** Images and colours. Only template art with a public URL is sent; personal images never are (Q18). */
import { sizeReason } from '../art-size.ts';
import { fits } from '../text.ts';
import type { CapabilityId, SamsungImageSlot, ViewImageFile, WalletPassView } from '../types.ts';
import { isChosen, note, type Run } from './context.ts';
import { type LimitedAttribute, SAMSUNG_LIMITS } from './limits.ts';

const usable = (f: ViewImageFile): boolean =>
  !f.personal && f.url !== undefined && f.locale === undefined;

/** The art for a slot: the author's `wallets/samsung/` file first, else the first Apple slot that has one. */
export function pickImage(
  view: WalletPassView,
  override: SamsungImageSlot,
  appleSlots: readonly string[],
): { url: string; slot: string } | undefined {
  const own = view.images.overrides.samsung?.[override];
  if (own && usable(own)) return { url: own.url as string, slot: `wallets.${override}` };
  for (const slot of appleSlots) {
    const file = view.images.apple[slot]?.find(usable);
    if (file) return { url: file.url as string, slot };
  }
  return undefined;
}

const SLOT_CAPABILITY: Record<string, CapabilityId> = {
  logo: 'image.logo',
  strip: 'image.strip',
  artwork: 'image.artwork',
  background: 'image.background',
  thumbnail: 'image.thumbnail',
};

/** Puts a picked image in `key`; a URL over the limit is dropped with an omission, never cut. */
export function setImage(
  run: Run,
  key: Extract<LimitedAttribute, 'logoImage' | 'bgImage' | 'mainImg'>,
  picked: { url: string; slot: string } | undefined,
  capability: CapabilityId,
): boolean {
  if (!picked) return false;
  const cap = SLOT_CAPABILITY[picked.slot] ?? capability;
  if (isChosen(run, cap, picked.slot)) {
    note(run, cap, picked.slot, 'omitted', 'Left out by the author.');
    return false;
  }
  if (!fits(picked.url, SAMSUNG_LIMITS[key])) {
    note(run, cap, picked.slot, 'omitted', 'The image address is too long for Samsung.');
    return false;
  }
  run.attrs[key] = picked.url;
  return true;
}

/**
 * What the Apple art lost: personal images, localized images, slots that have no public URL and
 * slots Samsung has no place for. `used` lists the Apple slots a picked image came from.
 */
export function reportImages(run: Run, used: ReadonlySet<string>): void {
  const apple = run.view.images.apple;
  for (const slot of Object.keys(apple).sort()) {
    const files = apple[slot] ?? [];
    if (files.some((f) => f.personal))
      note(run, 'image.personal', slot, 'omitted', 'Personal images are never sent to Samsung.');
    if (files.some((f) => !f.personal && f.locale !== undefined))
      note(run, 'localization.images', slot, 'difference', 'Samsung uses the default image.');
    const capability = SLOT_CAPABILITY[slot];
    const shared = files.filter((f) => !f.personal && f.locale === undefined);
    if (!capability || shared.length === 0) continue;
    if (!shared.some(usable)) {
      const sized = shared.map((f) => sizeReason('samsung', slot, f)).find(Boolean);
      note(run, capability, slot, 'omitted', sized ?? 'The image has no public address.');
    } else if (slot === 'thumbnail' || (slot !== 'logo' && !used.has(slot)))
      note(run, capability, slot, 'omitted', 'Samsung has no place for this image.');
  }
}

export function setColors(run: Run): void {
  const { background, foreground, label } = run.view.colors;
  const put = (key: 'bgColor' | 'fontColor', capability: CapabilityId, value?: string) => {
    if (!value) return;
    if (isChosen(run, capability)) note(run, capability, '', 'omitted', 'Left out by the author.');
    else run.attrs[key] = value;
  };
  put('bgColor', 'colors.background', background);
  put('fontColor', 'colors.foreground', foreground);
  if (label)
    note(
      run,
      'colors.label',
      '',
      'difference',
      'Samsung has no label colour field (fontColor is dark or light only): it picks them.',
    );
}
