import { describe, expect, it } from 'vitest';
import { crossPassRevocationFixture } from './asset-cross-pass-provenance-revocation-test-fixtures.ts';

describe('scanner asset cross-pass provenance', () => {
  it('revokes a scanned photo after transfer before opening', async () => {
    const { f, expectCrossPassRevoked } = await crossPassRevocationFixture();
    expect((await f.transfer()).state).toBe('pending');
    await expectCrossPassRevoked();
  }, 180_000);
});
