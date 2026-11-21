import { getPassSetup, patchPassSetup, stageBrandAsset } from '../brand/api.ts';
import type { Rgb } from '../templates/designer/contrast.ts';
import { toRgbText } from '../templates/designer/contrast.ts';
import { textColors } from './quick-setup.ts';

/**
 * Use blueprint on an organization with no brand yet writes the logo (the PNG the dialog placed,
 * base64) and colour to the organization in one staged save, so every template follows them. The
 * revision is read just before.
 */
export async function writeOrgBrand(
  orgId: string,
  brand: { logo?: string | undefined; color?: Rgb | undefined },
): Promise<void> {
  const setup = await getPassSetup(orgId);
  const logo = brand.logo ? await stageBrandAsset(orgId, { slot: 'logo', png: brand.logo }) : null;
  const colors = brand.color ? textColors(brand.color) : null;
  await patchPassSetup(
    orgId,
    {
      expectedRevision: setup.revision,
      brand: {
        ...(logo ? { logo: { sha: logo.sha } } : {}),
        ...(brand.color && colors
          ? {
              passColors: {
                background: toRgbText(brand.color),
                foreground: toRgbText(colors.foreground),
                label: toRgbText(colors.label),
              },
            }
          : {}),
      },
    },
    false,
  );
}
