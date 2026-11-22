import { describe, expect, it } from 'vitest';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { brandAssetUrls } from './new-pass-preview.tsx';

const NAMES = ['logo.png', 'logo@2x.png', 'icon.png', 'strip.png'];

describe('brandAssetUrls', () => {
  it('puts the organization logo and icon over the template ones, and nothing else', () => {
    const urls = brandAssetUrls(viewOf(readyFacts()), 'o1', 'tpl_gym', NAMES);
    expect(Object.keys(urls ?? {})).toEqual(['logo.png', 'logo@2x.png', 'icon.png']);
    expect(urls?.['logo@2x.png']).toMatch(/\/orgs\/o1\/branding\/logo\/2x\?v=/);
  });

  it('keeps the template own image where the template owns that part', () => {
    const view = viewOf(readyFacts());
    const tpl = view.templates.find((t) => t.id === 'tpl_gym');
    if (tpl) tpl.ownBrand = ['logo'];
    expect(Object.keys(brandAssetUrls(view, 'o1', 'tpl_gym', NAMES) ?? {})).toEqual(['icon.png']);
  });

  it('draws the template as it is while the organization has no images', () => {
    expect(brandAssetUrls(viewOf(newOrgFacts()), 'o1', 'tpl_gym', NAMES)).toBeUndefined();
    expect(brandAssetUrls(undefined, 'o1', 'tpl_gym', NAMES)).toBeUndefined();
  });
});
