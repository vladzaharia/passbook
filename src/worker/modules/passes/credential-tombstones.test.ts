import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../platform/ids.ts';
import { credentialTombstoneRef } from './credential-tombstones.ts';

const env = { KEK_V1: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDc=' };

describe('credential tombstone references', () => {
  it('uses stable keyed, tenant- and mode-scoped references', async () => {
    const digest = await sha256Hex('12345');
    const reference = await credentialTombstoneRef(env, 'org-a', 'live', digest);
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(reference).not.toBe(digest);
    expect(await credentialTombstoneRef(env, 'org-a', 'live', digest)).toBe(reference);
    expect(await credentialTombstoneRef(env, 'org-b', 'live', digest)).not.toBe(reference);
    expect(await credentialTombstoneRef(env, 'org-a', 'test', digest)).not.toBe(reference);
    expect(await credentialTombstoneRef(env, 'org-a', 'live', await sha256Hex('12346'))).not.toBe(
      reference,
    );
  });

  it('fails closed without a configured key', async () => {
    await expect(
      credentialTombstoneRef({}, 'org-a', 'live', await sha256Hex('12345')),
    ).rejects.toThrow('No KEK');
  });
});
