import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { brandingWarnings } from './branding.ts';

const SLUGS = [
  'starter-pack',
  'starter-timed-ticket',
  'starter-transit-ticket',
  'starter-booking',
  'starter-pickup',
  'starter-permit',
  'starter-id-card',
];
const none = { logoHasName: false, colors: null, images: [] };

describe.each(SLUGS)('%s placeholder art', (slug) => {
  const baked = bakedTemplates.find((t) => t.slug === slug);

  it('is a blueprint with a logo and an icon', () => {
    expect(baked?.blueprint).toBe(true);
    expect(baked?.assets.some((a) => a.slot === 'logo')).toBe(true);
    expect(baked?.assets.some((a) => a.slot === 'icon')).toBe(true);
  });

  it('warns on a template made from it that keeps the art', () => {
    const assets = (baked?.assets ?? []).map((a) => ({ slot: a.slot, sha1: a.sha1 }));
    const warnings = brandingWarnings({ id: 'tpl-copy', assets }, none, []);
    expect(warnings.map((w) => w.code)).toEqual(['PLATFORM_BRANDING']);
  });
});
