import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { assets, generic } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { assetUrlMap, CANDIDATE_ASSETS } from './assets.ts';
import { getBarcodeEngine } from './barcode-engine.ts';
import { PassCard } from './index.tsx';

// No sync-barcode import here: the browser path loads the encoders on demand (vitest.setup.web.ts).

const view = (extra = {}) =>
  normalize(generic, { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC', ...extra });

describe('lazy barcode', () => {
  it('draws a placeholder first, then the code once bwip-js has loaded', async () => {
    expect(getBarcodeEngine()).toBeUndefined();
    const { container } = render(<PassCard view={view()} />);
    expect(container.querySelector('.pc-barcode-pending')).not.toBeNull();
    expect(container.querySelector('svg.pc-barcode-svg')).toBeNull();
    expect(
      await screen.findByRole('img', { name: /barcode, approximate rendering/ }),
    ).toBeVisible();
    expect(container.querySelector('svg.pc-barcode-svg path')).not.toBeNull();
    expect(container.querySelector('.pc-barcode-pending')).toBeNull();
  });
});

describe('images', () => {
  it('hides an image that fails to load', () => {
    const v = view({ assets: { 'logo.png': '/x/logo.png' } });
    const { container } = render(<PassCard view={v} />);
    const img = container.querySelector('img.pc-logo-img');
    expect(img).not.toBeNull();
    fireEvent.error(img as Element);
    expect(container.querySelector('img.pc-logo-img')).toBeNull();
  });

  it('maps real names only when the server sends them', () => {
    expect(Object.keys(assetUrlMap('/a/', ['strip.png']))).toEqual(['strip.png']);
    expect(CANDIDATE_ASSETS).toEqual(
      expect.arrayContaining(['artwork.png', 'primaryLogo@2x.png', 'secondaryLogo@3x.png']),
    );
  });
});
