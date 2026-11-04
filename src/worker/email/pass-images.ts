/** A pass image under the public assets route (`passImages` in modules/public). */
export interface PassImageRef {
  name: string;
  path: string;
  width: number | null;
  height: number | null;
}

export interface PassEmailImages {
  iconUrl: string | null;
  /** Size in points: the file's pixels over its scale. */
  logo: { url: string; width: number; height: number } | null;
}

const SCALES = [3, 2, 1] as const;

/**
 * The pass's icon and logo for the email: the sharpest file of each, as absolute URLs. The logo
 * needs a recorded size (its box is fixed so a blocked image keeps the layout); the icon's box is
 * the band's 24 px square.
 */
export function passEmailImages(images: readonly PassImageRef[], base: string): PassEmailImages {
  const pick = (slot: 'icon' | 'logo', sized: boolean) => {
    for (const scale of SCALES) {
      const name = scale === 1 ? `${slot}.png` : `${slot}@${scale}x.png`;
      const image = images.find((i) => i.name === name && (!sized || (i.width && i.height)));
      if (image) return { image, scale };
    }
    return null;
  };
  const icon = pick('icon', false);
  const logo = pick('logo', true);
  return {
    iconUrl: icon ? `${base}${icon.image.path}` : null,
    logo: logo
      ? {
          url: `${base}${logo.image.path}`,
          width: (logo.image.width ?? 0) / logo.scale,
          height: (logo.image.height ?? 0) / logo.scale,
        }
      : null,
  };
}
