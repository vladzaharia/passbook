import { afterEach, describe, expect, it } from 'vitest';
import { artTransformFromBinding, setArtTransformForTest } from './assets.ts';

afterEach(() => setArtTransformForTest(null));

describe('artTransformFromBinding', () => {
  it('cuts nothing without a binding', async () => {
    const cut = await artTransformFromBinding(undefined)(new Uint8Array(), {
      width: 10,
      height: 10,
      fit: 'cover',
    });
    expect(cut).toBeNull();
  });

  it('uses the installed transform in place of the binding (the e2e server)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    setArtTransformForTest(async () => bytes);
    const cut = await artTransformFromBinding(undefined)(new Uint8Array(), {
      width: 10,
      height: 10,
      fit: 'cover',
    });
    expect(cut).toBe(bytes);
  });
});
