import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { setPlatformSamsungCard } from './credential-cards.ts';
import { revokePlatformCredential, savePlatformCredential } from './credential-service.ts';
import { cardMapOf, findActiveCredential } from './repo-credentials.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

async function platformSamsung() {
  const admin = await k.admin();
  const active = await findActiveCredential(env.DB, null, 'test', 'samsung');
  if (active)
    await revokePlatformCredential(k.ctx, admin.auth, active.id, {
      expectedRevision: active.revision,
    });
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    provider: 'samsung',
    mode: 'test',
    expectedRevision: 0,
    credentials: k.samsung(),
  } as never);
  return { admin, saved };
}

describe('a Samsung card for one more type, set without the partner secrets', () => {
  it('adds the card as a new version, keeps the others, and lists the types that have one', async () => {
    const { admin, saved } = await platformSamsung();
    expect(saved.cardTypes).toEqual(['loyalty']);
    const before = await cardMapOf(env.DB, (await versionOf(saved.id)) ?? null);
    const next = await setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
      type: 'ticket',
      cardId: 'ticketcard',
      expectedRevision: saved.revision,
    });
    expect(next).toMatchObject({ id: saved.id, revision: saved.revision + 1 });
    expect(next.cardTypes).toEqual(['loyalty', 'ticket']);
    const after = await cardMapOf(env.DB, (await versionOf(saved.id)) ?? null);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), 'ticket'].sort());
    for (const [type, hash] of Object.entries(before)) expect(after[type]).toBe(hash);
    expect(JSON.stringify(next)).not.toContain('ticketcard');
  });

  it('is repeatable with the same card, and refuses a different one for the same type', async () => {
    const { admin, saved } = await platformSamsung();
    const first = await setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
      type: 'coupon',
      cardId: 'couponcard',
      expectedRevision: saved.revision,
    });
    expect(
      await setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
        type: 'coupon',
        cardId: 'couponcard',
        expectedRevision: first.revision,
      }),
    ).toMatchObject({ revision: first.revision });
    await expect(
      setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
        type: 'coupon',
        cardId: 'othercard',
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CARD_SET' });
  });

  it('refuses a stale revision, a revoked credential and a caller who is not a platform admin', async () => {
    const { admin, saved } = await platformSamsung();
    await expect(
      setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
        type: 'ticket',
        cardId: 'ticketcard',
        expectedRevision: saved.revision + 5,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await expect(
      setPlatformSamsungCard(k.ctx, auth, saved.id, {
        type: 'ticket',
        cardId: 'ticketcard',
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await revokePlatformCredential(k.ctx, admin.auth, saved.id, {
      expectedRevision: saved.revision,
    });
    await expect(
      setPlatformSamsungCard(k.ctx, admin.auth, saved.id, {
        type: 'ticket',
        cardId: 'ticketcard',
        expectedRevision: saved.revision + 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

async function versionOf(credentialId: string) {
  return (
    await first<{ current_version_id: string }>(
      env.DB,
      'SELECT current_version_id FROM wallet_credentials WHERE id = ?',
      [credentialId],
    )
  )?.current_version_id;
}
