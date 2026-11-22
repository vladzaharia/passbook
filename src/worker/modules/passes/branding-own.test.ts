import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { appliedBranding, readBranding, tenantPassJson } from './branding.ts';

const org = readBranding({
  passColors: { background: '#112233', foreground: '#ffffff', label: '#cccccc' },
  logo: { sha: 'a'.repeat(40), w: 160, h: 50 },
  icon: { sha: 'b'.repeat(40), w: 87, h: 87 },
});
const base = {
  backgroundColor: 'rgb(1,2,3)',
  foregroundColor: 'rgb(4,5,6)',
  labelColor: 'rgb(7,8,9)',
  description: 'Pass',
} as unknown as PassJson;
const build = (manifest?: Parameters<typeof appliedBranding>[1]) =>
  tenantPassJson(base, 'Acme', appliedBranding(org, manifest));

describe('manifest brand block in the build', () => {
  it('a template without the block builds as it always did: the organization wins', () => {
    expect(appliedBranding(org)).toBe(org);
    expect(appliedBranding(org, {})).toBe(org);
    expect(appliedBranding(org, { brand: { colors: 'org', logo: 'org' } })).toBe(org);
    expect(build().backgroundColor).toBe('#112233');
  });

  it('colors: template keeps the template colours', () => {
    const pass = build({ brand: { colors: 'template' } });
    expect(pass.backgroundColor).toBe('rgb(1,2,3)');
    expect(pass.foregroundColor).toBe('rgb(4,5,6)');
    expect(pass.labelColor).toBe('rgb(7,8,9)');
  });

  it('logo and icon: template leave the template image where the organization has one', () => {
    const own = appliedBranding(org, { brand: { logo: 'template' } });
    expect(own.images.map((i) => i.slot)).toEqual(['icon']);
    expect(own.colors).toEqual(org.colors);
    const both = appliedBranding(org, { brand: { logo: 'template', icon: 'template' } });
    expect(both.images).toEqual([]);
  });
});
