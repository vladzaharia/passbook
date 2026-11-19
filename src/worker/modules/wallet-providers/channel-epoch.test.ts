import { describe, expect, it } from 'vitest';
import { googleBase64Url } from './google-crypto.ts';
import { googleObjectIds } from './google-ids.ts';
import type { WalletInstance } from './instance-types.ts';
import { channelOffSuccessor } from './offers-instance.ts';

const secret = new Uint8Array(32).fill(9);
const scope = { tenantId: 'org-1', releaseId: 'rel-1', passId: 'pass-1', mode: 'live' as const };

/** The original derivation, written out independently of google-ids.ts. */
async function reference(kind: 'class' | 'object', values: (string | number)[]) {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = JSON.stringify([
    'passbook-google-wallet-v1',
    '33880000000223344',
    kind,
    ...values,
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `33880000000223344.${kind === 'class' ? 'c' : 'o'}_${googleBase64Url(new Uint8Array(mac))}`;
}

describe('Google object ids by channel epoch', () => {
  it('keeps epoch 1 ids as originally derived and appends the epoch from 2', async () => {
    const ids = (channelEpoch = 1) =>
      googleObjectIds('33880000000223344', secret, {
        ...scope,
        credentialGeneration: 3,
        channelEpoch,
      });
    const original = await reference('object', ['org-1', 'live', 'pass-1', 3]);
    expect((await ids()).objectId).toBe(original);
    expect((await ids(1)).objectId).toBe(original);
    expect((await ids(2)).objectId).toBe(
      await reference('object', ['org-1', 'live', 'pass-1', 3, 2]),
    );
    expect((await ids(2)).objectId).not.toBe((await ids(3)).objectId);
    expect((await ids(2)).classId).toBe(await reference('class', ['org-1', 'rel-1']));
    for (const bad of [0, 17, 1.5, Number.NaN])
      await expect(ids(bad)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

const instance = (patch: Partial<WalletInstance>) =>
  ({
    lifecycle: 'revoked',
    retirementCause: 'channel_off',
    channelEpoch: 1,
    ...patch,
  }) as WalletInstance;

describe('successor offer holds', () => {
  it('holds while the predecessor is revoking, frees it once settled, and stops at the epoch limit', () => {
    expect(channelOffSuccessor(instance({ retirementCause: null }))).toBeNull();
    expect(channelOffSuccessor(instance({ lifecycle: 'revoking' }))).toEqual({
      hold: 'provider_retiring',
      epoch: 2,
    });
    expect(channelOffSuccessor(instance({ lifecycle: 'active' }))?.hold).toBe('provider_retiring');
    expect(channelOffSuccessor(instance({}))).toEqual({ hold: null, epoch: 2 });
    expect(channelOffSuccessor(instance({ lifecycle: 'retired', channelEpoch: 15 }))).toEqual({
      hold: null,
      epoch: 16,
    });
    expect(channelOffSuccessor(instance({ channelEpoch: 16 }))?.hold).toBe('provider_epoch_limit');
  });
});
