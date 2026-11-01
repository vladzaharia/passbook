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
});
