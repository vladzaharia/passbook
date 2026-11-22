import type { PassSetupPatch } from '@/shared/contracts/pass-setup.ts';
import { getPassSetup, patchPassSetup } from '../brand/api.ts';
import { stagedRef } from '../brand/draft.ts';
import { stageImage } from '../brand/images.ts';
import { type Rgb, toHex } from '../templates/designer/contrast.ts';
import { textColors } from './quick-setup.ts';

/**
 * "Use for all passes": the colour and logo become the organization's pass brand, through the same
 * PATCH the Pass setup page saves with. The revision is read just before, so a save by someone
 * else in between fails with PASS_SETUP_CHANGED instead of being overwritten.
 */
export async function saveOrgBrand(
  orgId: string,
  brand: { color?: Rgb | undefined; logo?: File | undefined },
): Promise<void> {
  const patch: NonNullable<PassSetupPatch['brand']> = {};
  if (brand.color) {
    const { foreground, label } = textColors(brand.color);
    patch.passColors = {
      background: toHex(brand.color),
      foreground: toHex(foreground),
      label: toHex(label),
    };
  }
  if (brand.logo) patch.logo = stagedRef(await stageImage(orgId, 'logo', brand.logo));
  if (Object.keys(patch).length === 0) return;
  const setup = await getPassSetup(orgId);
  await patchPassSetup(orgId, { expectedRevision: setup.revision, brand: patch }, false);
}

/** On when the organization has no pass branding of its own yet. */
export const unbranded = (brand: {
  passColors: { source: string };
  logo: { source: string };
}): boolean => brand.passColors.source === 'passbook' && brand.logo.source === 'passbook';
