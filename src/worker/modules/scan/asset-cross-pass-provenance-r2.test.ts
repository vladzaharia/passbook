import { describe, expect, it, vi } from 'vitest';
import {
  crossPassRevocationFixture,
  expectMissing,
} from './asset-cross-pass-provenance-revocation-test-fixtures.ts';
import { observeCancellation } from './asset-test-fixtures.ts';

describe('scanner asset cross-pass provenance', () => {
  it('revokes a scanned photo after transfer during R2 access', async () => {
    const { f, scanned, expectCrossPassRevoked } = await crossPassRevocationFixture();
    const originalGet = f.t.kit.env.BUCKET.get.bind(f.t.kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi
      .spyOn(f.t.kit.env.BUCKET, 'get')
      .mockImplementation(async (objectKey, options) => {
        const object = await originalGet(objectKey, options);
        if (objectKey !== f.photo.r2_key || !object) return object;
        opened = true;
        expect((await f.transfer()).state).toBe('pending');
        return observeCancellation(object, () => cancelled++);
      });
    try {
      await expectMissing(await f.request(scanned.photoUrl));
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await expectCrossPassRevoked();
  }, 180_000);
});
