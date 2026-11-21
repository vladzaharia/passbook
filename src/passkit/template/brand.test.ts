import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { brandManifestIssues, ownBrandParts } from './brand.ts';

const m = (brand: unknown) => ({ brand }) as unknown as TemplateManifest;

describe('manifest brand block', () => {
  it('accepts org and template per known part, or no block', () => {
    expect(brandManifestIssues(m(undefined))).toEqual([]);
    expect(brandManifestIssues(m({ colors: 'org', logo: 'template', icon: 'template' }))).toEqual(
      [],
    );
  });

  it('refuses unknown parts, other values and other shapes', () => {
    expect(brandManifestIssues(m({ banner: 'org' }))[0]?.code).toBe('BRAND_UNKNOWN');
    expect(brandManifestIssues(m({ logo: 'both' }))[0]?.code).toBe('BRAND_SOURCE');
    expect(brandManifestIssues(m(['logo']))[0]?.code).toBe('BRAND_SHAPE');
  });

  it('lists the parts a template keeps', () => {
    expect(ownBrandParts(m({ colors: 'template', logo: 'org', icon: 'template' }))).toEqual([
      'colors',
      'icon',
    ]);
    expect(ownBrandParts(undefined)).toEqual([]);
    expect(ownBrandParts(m(undefined))).toEqual([]);
  });
});
