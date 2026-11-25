import { afterEach, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { fixture, restore } from './google-runtime-test-fixtures.ts';
import type { WalletInstance } from './instance.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { instanceCanActivate } from './offers-instance.ts';

const instance = (over: Partial<WalletInstance>) =>
  ({
    lifecycle: 'active',
    credentialGeneration: 2,
    retirementCause: null,
    channelEpoch: 1,
    ...over,
  }) as WalletInstance;

// Listing and issuing share this check, for both providers: an offer listed is an offer issue can create.
describe('an offer can only be listed when issue can activate its slot', () => {
  it.each([
    ['no instance yet', null, true],
    ['an active instance at the pass generation', instance({}), true],
    ['an active instance at an older generation', instance({ credentialGeneration: 1 }), false],
    [
      'a ready placeholder after a transfer',
      instance({ lifecycle: 'ready', desiredVersion: 0 }),
      true,
    ],
    [
      'a ready placeholder that already has an operation',
      instance({ lifecycle: 'ready', desiredVersion: 1 }),
      false,
    ],
    ['a blocked placeholder', instance({ lifecycle: 'blocked' }), false],
    [
      'a settled channel-off predecessor (a successor is born active)',
      instance({ lifecycle: 'retired', retirementCause: 'channel_off', credentialGeneration: 1 }),
      true,
    ],
  ])('%s', (_name, existing, expected) => {
    expect(instanceCanActivate(existing, 2)).toBe(expected);
  });
});

describe('a trigger that refuses the activation is a 404', () => {
  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo();
    vi.unstubAllGlobals();
  });

  it('maps the abort to not found, never a 500', async () => {
    const { f } = await fixture();
    // A second pass has no instance yet, so issuing creates one (the insert the trigger refuses).
    const second = await f.kit.pass({ holderEmail: 'second@example.test' });
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    const token = offer?.href.split('/')[2] ?? '';
    expect(token).not.toBe('');
    await run(
      f.kit.env.DB,
      "CREATE TRIGGER force_abort BEFORE INSERT ON wallet_provider_instance_operations BEGIN SELECT RAISE(ABORT, 'provider operation is not authorized'); END",
    );
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      status: 404,
    });
    // Without the trigger the same call gets through, so the 404 above came from the abort.
    await run(f.kit.env.DB, 'DROP TRIGGER force_abort');
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).resolves.toMatch(/^https:\/\//);
  });

  it('a ready placeholder (a new holder after a transfer) is listed and activates on the tap', async () => {
    const { f } = await fixture();
    const db = f.kit.env.DB;
    const second = await f.kit.pass({ holderEmail: 'new-holder@example.test' });
    const row = await first<{ credential_generation: number }>(
      db,
      'SELECT credential_generation FROM passes WHERE id = ?',
      [second.id],
    );
    const keyset = await requireCredentialRefKeyset(db, f.kit.env);
    const now = f.kit.clock.now();
    await run(
      db,
      `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation,
        lifecycle, desired_version, created_at, updated_at, credential_keyset_commitment)
       VALUES (?, ?, ?, ?, 'google', ?, 'ready', 0, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        second.id,
        second.orgId,
        second.mode,
        row?.credential_generation ?? 1,
        now,
        now,
        keyset,
      ],
    );
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    expect(offer?.provider).toBe('google');
    await expect(
      issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google'),
    ).resolves.toMatch(/^https:\/\/pay\.google\.com\//);
    expect(
      await first(db, 'SELECT lifecycle FROM wallet_provider_instances WHERE pass_id = ?', [
        second.id,
      ]),
    ).toEqual({ lifecycle: 'active' });
  });
});
