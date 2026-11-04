import { describe, expect, it } from 'vitest';
import { type PassImageRef, passEmailImages } from './pass-images.ts';

const BASE = 'https://w.test';
const image = (name: string, width: number | null = null, height: number | null = null) =>
  ({ name, path: `/p/t/assets/${name}?v=1`, width, height }) satisfies PassImageRef;

describe('passEmailImages', () => {
  it('takes the sharpest icon and logo, the logo sized in points', () => {
    const { iconUrl, logo } = passEmailImages(
      [
        image('icon.png', 29, 29),
        image('icon@3x.png'),
        image('logo@2x.png', 216, 100),
        image('logo@3x.png', 324, 150),
        image('strip@3x.png', 1125, 369),
      ],
      BASE,
    );
    expect(iconUrl).toBe(`${BASE}/p/t/assets/icon@3x.png?v=1`);
    expect(logo).toEqual({ url: `${BASE}/p/t/assets/logo@3x.png?v=1`, width: 108, height: 50 });
  });

  it('skips a logo file without a recorded size', () => {
    const { logo } = passEmailImages([image('logo@3x.png'), image('logo@2x.png', 216, 100)], BASE);
    expect(logo?.url).toBe(`${BASE}/p/t/assets/logo@2x.png?v=1`);
    expect(passEmailImages([image('logo@3x.png')], BASE).logo).toBeNull();
  });

  it('has nothing to show for a pass without icon or logo files', () => {
    expect(passEmailImages([image('en.lproj/logo@2x.png', 216, 100)], BASE)).toEqual({
      iconUrl: null,
      logo: null,
    });
  });
});
