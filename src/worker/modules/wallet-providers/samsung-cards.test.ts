import { beforeAll, describe, expect, it } from 'vitest';
import { providerIdentityHash } from './projection-contract.ts';
import { samsungCardId, samsungCardMap } from './samsung-cards.ts';
import { validateSamsungCredentials } from './samsung-credentials.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const creds = () => ({ ...k.samsung('cardG'), cardIds: { ticket: 'cardT', coupon: 'cardC' } });

describe('Samsung card per type', () => {
  it('a type uses its own card, else the default, never another type', () => {
    const c = creds();
    expect(samsungCardId(c, 'ticket')).toBe('cardT');
    expect(samsungCardId(c, 'coupon')).toBe('cardC');
    expect(samsungCardId(c, 'loyalty')).toBe('cardG');
  });

  it('the runtime account of type X carries X card only', async () => {
    const now = Date.now();
    expect((await validateSamsungCredentials(creds(), now, 'ticket')).cardId).toBe('cardT');
    expect((await validateSamsungCredentials(creds(), now, 'coupon')).cardId).toBe('cardC');
    expect((await validateSamsungCredentials(creds(), now, 'loyalty')).cardId).toBe('cardG');
  });

  it('the identity hash keeps the partner and the type card', async () => {
    const snap = { provider: 'samsung' as const, credentials: creds() };
    const hashes = await Promise.all(
      ['ticket', 'coupon', 'loyalty'].map((t) => providerIdentityHash(snap, t)),
    );
    expect(new Set(hashes).size).toBe(3);
    const plain = { provider: 'samsung' as const, credentials: k.samsung('cardG') };
    expect(await providerIdentityHash(plain, 'loyalty')).toBe(hashes[2]);
  });

  it('the card map hashes the default and every type', async () => {
    expect(Object.keys(await samsungCardMap(creds())).sort()).toEqual([
      'coupon',
      'generic',
      'ticket',
    ]);
  });
});
