// ENR-REV: an account set up through an enrolment, with no legacy envelope and a `revision` column of 0, issues end
// to end against the mock wallets, every database guard in place. Its pins are `enrolment_revision` and the
// authority epoch, and a Samsung card is verified, refreshed and retired through the credential version its
// reference pins.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { all, first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { deletePass, updatePass, voidPass } from '../passes/service.ts';
import { readSamsungIssuedRefVerification } from './account-credential-historical.ts';
import { readSamsungTombstoneVerification } from './account-credential-read.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { fixture, mock, publishRelease, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

const system = { type: 'system', id: null } as const;

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const account = (db: D1Database, orgId: string, provider: 'google' | 'samsung') =>
  first<{
    id: string;
    credential_id: string | null;
    revision: number;
    enrolment_revision: number;
    sourced: number;
    enabled: number;
  }>(
    db,
    `SELECT id, credential_id, revision, enrolment_revision, credential_source_id IS NOT NULL AS sourced,
      enabled_at IS NOT NULL AS enabled
     FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = ?`,
    [orgId, provider],
  );

describe('an enrolment-only Google account', () => {
  it('releases a candidate, issues, edits, follows a template update and voids with every guard in place', async () => {
    const { f } = await fixture(undefined, { enrolled: true, guards: true });
    const db = f.kit.env.DB;
    expect(await account(db, f.kit.org.id, 'google')).toMatchObject({
      credential_id: null,
      revision: 0,
      sourced: 1,
      enabled: 1,
    });
    const jobCtx = jobCtxOf(f.kit);
    const object = () => [...mock.google.genericObject.values()][0];

    // The first tap: the offer, the instance and the object come from the release the candidate trigger accepted.
    const location = await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(object()).toMatchObject({ state: 'ACTIVE' });
    expect(
      await first(
        db,
        "SELECT lifecycle FROM wallet_provider_instances WHERE provider = 'google' AND pass_id = ?",
        [f.pass.id],
      ),
    ).toEqual({ lifecycle: 'active' });

    // An edit is an operation pinned to the enrolment revision and its epoch.
    const mark = mock.requests.length;
    await updatePass(
      jobCtx,
      system,
      f.pass.id,
      { input: { memberName: 'Edited' } },
      { scope: null },
    );
    await drainWalletProviderSync(jobCtx);
    expect(
      mock.requests
        .slice(mark)
        .filter((r) => r.path.includes('walletobjects'))
        .map((r) => r.method),
    ).toEqual(['PATCH']);
    expect(JSON.stringify(object())).toContain('Edited');

    // A template update: a second Google release on the same enrolment, then a new pass issued under it.
    await publishRelease(f, 1);
    expect(
      await first(
        db,
        "SELECT MAX(generation) AS generation FROM template_releases WHERE provider = 'google' AND source = 'approved'",
      ),
    ).toEqual({ generation: 2 });
    const next = await f.kit.pass({ holderEmail: 'next@example.test' });
    const [offer] = await listWalletOffers(f.kit.ctx, next.id);
    const nextToken = offer?.href.split('/')[2];
    if (!nextToken) throw new Error('The new pass was offered no link.');
    await issueWalletOffer(f.kit.ctx, nextToken, 'google');
    expect(mock.google.genericObject.size).toBe(2);
    expect(
      await first(
        db,
        `SELECT r.generation FROM wallet_provider_instances i
         JOIN template_releases r ON r.id = i.identity_projection_release_id
         WHERE i.provider = 'google' AND i.pass_id = ?`,
        [next.id],
      ),
    ).toEqual({ generation: 2 });

    // A void reaches the object the first pass saved.
    await voidPass(jobCtx, system, f.pass.id, {
      orgId: f.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    await drainWalletProviderSync(jobCtx);
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });
});

describe('an enrolment-only Samsung account', () => {
  const mocked = () => {
    const wallets = createMockWallets();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'tsapi-card.walletsvc.samsung.com')
        throw new Error(`Unexpected request to ${url.hostname}`);
      const { redirect: _r, signal: _s, ...rest } = init ?? {};
      return wallets.handle(new Request(`http://mock.test${url.pathname}`, rest));
    });
    return wallets;
  };

  beforeAll(() => {
    setWalletProvidersEnabledForTest(true);
  });

  it('verifies a card by the version its reference pins, refreshes it, and retires it with a tombstone', async () => {
    const t = await setupSamsungCallbacks({ enrolled: true });
    const wallets = mocked();
    const db = t.kit.env.DB;
    const row = await account(db, t.kit.org.id, 'samsung');
    expect(row).toMatchObject({ credential_id: null, revision: 0, sourced: 1, enabled: 1 });
    if (!row) throw new Error('Missing enrolment.');
    const ctx = jobCtxOf(t.kit);

    // ADDED promotes the reference, and the sync job refreshes it (UPDATED).
    expect(
      (
        await t.call({
          method: 'POST',
          token: await t.token({ method: 'POST' }),
          query: '?cc2=gb&event=ADDED',
        })
      ).status,
    ).toBe(200);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(wallets.samsungRefs.get(t.refId)?.state).toBe('UPDATED');

    // The issued-reference read has no configure event to find: the reference's own pin names the credential.
    const refHash = await sha256Hex(t.refId);
    const pin = await first<{ credential_version_id: string | null }>(
      db,
      'SELECT credential_version_id FROM wallet_samsung_fetch_refs WHERE ref_hash = ?',
      [refHash],
    );
    expect(pin?.credential_version_id).not.toBeNull();
    expect(
      await readSamsungIssuedRefVerification(t.kit.ctx, {
        orgId: t.kit.org.id,
        mode: 'live',
        accountId: row.id,
        accountRevision: row.enrolment_revision,
        refHash,
      }),
    ).toMatchObject({
      accountId: row.id,
      partnerId: t.samsung.partnerId,
      certificateId: t.samsung.certificateId,
      writable: true,
    });

    // A delete sends DELETED and buries the card under a tombstone that keeps the pin.
    await deletePass(ctx, system, t.pass.id, null);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(wallets.samsungRefs.get(t.refId)?.state).toBe('DELETED');
    const tombstone = await first<{
      account_revision: number;
      credential_version_id: string | null;
    }>(
      db,
      'SELECT account_revision, credential_version_id FROM wallet_samsung_tombstones WHERE ref_hash = ?',
      [refHash],
    );
    expect(tombstone?.credential_version_id).toBe(pin?.credential_version_id);
    expect(
      await readSamsungTombstoneVerification(t.kit.ctx, {
        orgId: t.kit.org.id,
        mode: 'live',
        accountId: row.id,
        accountRevision: tombstone?.account_revision ?? 0,
        refHash,
      }),
    ).toMatchObject({ accountId: row.id, partnerId: t.samsung.partnerId });
    expect(
      await all(db, "SELECT lifecycle FROM wallet_provider_instances WHERE provider = 'samsung'"),
    ).toEqual([{ lifecycle: 'retired' }]);
  });
});
