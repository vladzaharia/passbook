import { describe, expect, it } from 'vitest';
import { safeImageUrl } from '../../shared/pass-view/images.ts';
import { assetUrlMap } from './assets.ts';

const { origin } = (globalThis as unknown as { location: { origin: string } }).location;

describe('assetUrlMap', () => {
  it('serves same-origin assets by path, so http dev origins pass the image filter', () => {
    const map = assetUrlMap(`${origin}/p/tok/assets/`, ['logo@2x.png']);
    expect(map['logo@2x.png']).toBe('/p/tok/assets/logo%402x.png');
    expect(safeImageUrl(map['logo@2x.png'] ?? '')).toBe(true);
  });

  it('keeps other origins absolute', () => {
    const map = assetUrlMap('https://cdn.example/p/tok/assets', ['icon.png']);
    expect(map['icon.png']).toBe('https://cdn.example/p/tok/assets/icon.png');
  });

  it.each([
    ['/assets?orgId=org%201', '/assets/logo%402x.png?orgId=org%201'],
    ['/assets///?orgId=org-1#preview', '/assets/logo%402x.png?orgId=org-1#preview'],
    ['assets/#preview', 'assets/logo%402x.png#preview'],
    [`${origin}/assets/?orgId=org-1#preview`, '/assets/logo%402x.png?orgId=org-1#preview'],
    [
      'https://cdn.example/assets/?orgId=org-1#preview',
      'https://cdn.example/assets/logo%402x.png?orgId=org-1#preview',
    ],
  ])('inserts the asset name before the query or fragment in %s', (base, expected) => {
    expect(assetUrlMap(base, ['logo@2x.png'])['logo@2x.png']).toBe(expected);
  });
});
