import { constants, privateDecrypt } from 'node:crypto';
import { compactVerify, importX509 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { fromBase64Url, sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { configureWalletProviderAccount, getWalletProviderReadiness } from './account-service.ts';
import { ensureSamsungFetchRef } from './callbacks-ref.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { consumeWalletOfferRef, readWalletPassSnapshot, walletOfferFresh } from './instance.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { findSamsungFetchSnapshot, samsungFetchSnapshotCurrent } from './repo-callbacks.ts';
import { claimSamsungFetch, claimSamsungReceipt } from './repo-callbacks-events.ts';
import { readOffer } from './repo-instance-offers.ts';
import { seedHistoricalOfferRef } from './runtime-historical-fixtures.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

async function decryptCard(
  cdata: string,
  certificate: string,
  privateKey: string,
): Promise<unknown> {
  const outer = await compactVerify(cdata, await importX509(certificate, 'RS256'), {
    algorithms: ['RS256'],
  });
  const compact = new TextDecoder().decode(outer.payload).split('.');
  if (compact.length !== 5) throw new Error('Invalid encrypted card fixture');
  const [header = '', wrapped = '', iv = '', ciphertext = '', tag = ''] = compact;
  const block = privateDecrypt(
    { key: privateKey, padding: constants.RSA_NO_PADDING },
    fromBase64Url(wrapped),
  );
  const separator = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('Invalid key envelope');
  const key = await crypto.subtle.importKey(
    'raw',
    block.subarray(separator + 1),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(iv),
      additionalData: new TextEncoder().encode(header),
      tagLength: 128,
    },
    key,
    new Uint8Array([...fromBase64Url(ciphertext), ...fromBase64Url(tag)]),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

describe('Samsung authenticated callback route', () => {
  it('requires the pinned signature and exact path, method, account and time', async () => {
    const t = await setupSamsungCallbacks();
    expect((await t.call()).status).toBe(401);
    const valid = await t.token();
    const tampered = `${valid.slice(0, valid.lastIndexOf('.') + 1)}${'A'.repeat(342)}`;
    expect((await t.call({ token: tampered })).status).toBe(401);
    expect((await t.call({ token: await t.token({ signedPath: `${t.path}x` }) })).status).toBe(401);
    expect((await t.call({ token: await t.token({ method: 'POST' }) })).status).toBe(401);
    expect((await t.call({ token: await t.token({ partnerId: 'other' }) })).status).toBe(401);
    expect((await t.call({ token: await t.token({ certificateId: 'ZZZZ' }) })).status).toBe(401);
    expect((await t.call({ token: await t.token({ tokenRefId: 'B'.repeat(32) }) })).status).toBe(
      401,
    );
    expect(
      (await t.call({ token: await t.token({ utc: t.kit.clock.now() - 30_001 }) })).status,
    ).toBe(401);
    expect(
      (await t.call({ token: await t.token({ utc: t.kit.clock.now() + 5_001 }) })).status,
    ).toBe(401);
    const signedQuery = await t.token({ signedPath: `${t.path}?fields=title` });
    expect((await t.call({ token: signedQuery, query: '?fields=providerName' })).status).toBe(401);
  }, 60_000);

  it('refreshes an already-promoted ref, prevents replay and survives the old offer window', async () => {
    const t = await setupSamsungCallbacks();
    const auth = await t.token();
    const response = await t.call({ token: auth, query: '?fields=title' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const { cdata } = z.object({ cdata: z.string() }).parse(await response.json());
    expect(cdata).toBeTruthy();
    expect(cdata).not.toContain('Member');
    const decoded = await decryptCard(
      cdata,
      t.samsung.partnerCertificatePem,
      t.samsung.partnerPrivateKeyPem,
    );
    expect(decoded).toMatchObject({
      card: {
        type: 'loyalty',
        data: [{ refId: t.refId, state: 'ACTIVE', attributes: { title: expect.any(String) } }],
      },
    });
    const parsed = z
      .object({
        card: z.object({
          data: z.array(
            z.object({
              attributes: z.record(z.string(), z.unknown()),
            }),
          ),
        }),
      })
      .parse(decoded);
    expect(Object.keys(parsed.card.data[0]?.attributes ?? {})).toEqual(['title']);
    expect((await t.call({ token: auth, query: '?fields=providerName' })).status).toBe(401);
    t.kit.clock.advance(300_001);
    await t.renewEvidence();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
  }, 60_000);

  it('denies new offers and does not promote an unpromoted ref without market proof', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    await expect(
      issueWalletOffer(t.kit.ctx, t.pass.downloadToken, 'samsung'),
    ).rejects.toMatchObject({ status: 404 });
    expect((await t.call({ token: await t.token() })).status).toBe(401);
    const snapshot = await findSamsungFetchSnapshot(
      t.kit.env.DB,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
    );
    if (!snapshot) throw new Error('Missing unpromoted fixture');
    const raw = await passJsonAtVersion(t.kit.env.DB, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const now = t.kit.clock.now();
    expect(
      await claimSamsungFetch(
        t.kit.env.DB,
        snapshot,
        {
          tokenHash: 'E'.repeat(43),
          claimId: t.kit.ctx.ids.id(),
          now,
          expiresAt: now + 30_000,
        },
        raw,
      ),
    ).toBe(false);
    const row = await first<{ promoted_at: number | null }>(
      t.kit.env.DB,
      'SELECT promoted_at FROM wallet_samsung_fetch_refs WHERE id = ?',
      [t.referenceId],
    );
    expect(row?.promoted_at).toBeNull();
  }, 60_000);

  it('encrypts untrusted callback bodies, deduplicates replay, and never infers installation', async () => {
    const t = await setupSamsungCallbacks();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const body =
      '{"callback":"https://evil.example/private-token","member":"private@example.test"}';
    const post = await t.token({ method: 'POST' });
    expect(
      (await t.call({ method: 'POST', token: post, query: '?cc2=gb&event=ADDED', body })).status,
    ).toBe(200);
    expect(
      (await t.call({ method: 'POST', token: post, query: '?cc2=us&event=DELETED', body })).status,
    ).toBe(401);
    const deletion = await t.token({ method: 'POST' });
    expect(
      (await t.call({ method: 'POST', token: deletion, query: '?cc2=us&event=DELETED', body }))
        .status,
    ).toBe(200);
    const instance = await first<{ id: string; installation_state: string }>(
      t.kit.env.DB,
      "SELECT id, installation_state FROM wallet_provider_instances WHERE pass_id = ? AND provider = 'samsung'",
      [t.pass.id],
    );
    expect(instance?.installation_state).toBe('unknown');
    const rows = await all<{
      id: string;
      org_id: string;
      mode: string;
      instance_id: string;
      kek_version: number;
      iv: number[];
      wrapped_dek: number[];
      ciphertext: number[];
      kind: string;
    }>(
      t.kit.env.DB,
      'SELECT * FROM wallet_samsung_callback_receipts WHERE instance_id = ? ORDER BY received_at',
      [instance?.id],
    );
    expect(rows).toHaveLength(2);
    const row = rows[0];
    if (!row) throw new Error('Missing receipt fixture');
    expect(JSON.stringify(rows)).not.toContain('private@example.test');
    expect(JSON.stringify(rows)).not.toContain('evil.example');
    expect(row.kind).toBe('state_callback');
    const envelope = {
      kekVersion: row.kek_version,
      iv: new Uint8Array(row.iv),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      ciphertext: new Uint8Array(row.ciphertext),
    };
    const aad = credentialAad(
      row.id,
      row.org_id,
      `samsung-callback|${row.mode}|${row.instance_id}`,
    );
    expect(await decryptSecretText(await loadKekRing(t.kit.env), envelope, aad)).toBe(body);
    const hints = await all<{ country_code: string }>(
      t.kit.env.DB,
      `SELECT h.country_code FROM wallet_samsung_country_hints h
       JOIN wallet_samsung_fetch_refs r ON r.id = h.ref_id WHERE r.instance_id = ? ORDER BY h.country_code`,
      [instance?.id],
    );
    expect(hints.map((h) => h.country_code)).toEqual(['GB', 'US']);
  }, 60_000);

  it('rejects stale pass revisions, cross-tenant/mode references and rotated accounts', async () => {
    const t = await setupSamsungCallbacks();
    const instance = await first<{ id: string; desired_version: number }>(
      t.kit.env.DB,
      "SELECT id, desired_version FROM wallet_provider_instances WHERE pass_id = ? AND provider = 'samsung'",
      [t.pass.id],
    );
    if (!instance) throw new Error('Missing instance fixture');
    const binding = {
      instanceId: instance.id,
      orgId: t.kit.org.id,
      mode: 'live' as const,
      operationVersion: instance.desired_version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      expiresAt: t.kit.clock.now() + 60_000,
    };
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
        ...binding,
        orgId: 'other-tenant',
      }),
    ).toBeNull();
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, { ...binding, mode: 'test' }),
    ).toBeNull();
    await run(t.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [t.pass.id]);
    expect((await t.call({ token: await t.token() })).status).toBe(401);

    const rotated = await setupSamsungCallbacks();
    const scope = {
      orgId: rotated.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const account = await getWalletProviderReadiness(rotated.kit.ctx, scope);
    await configureWalletProviderAccount(rotated.kit.ctx, rotated.auth, {
      ...scope,
      expectedRevision: account.revision,
      credentials: rotated.samsung,
    });
    expect((await rotated.call({ token: await rotated.token() })).status).toBe(401);
  }, 90_000);

  it('fences captured offers, refreshes and callbacks when a real credential transfer starts', async () => {
    const t = await setupSamsungCallbacks({ holderEmail: 'first@example.test' });
    const db = t.kit.env.DB;
    expect(await setDownloadToken(db, t.pass, t.kit.ctx.ids.token(32), t.kit.clock.now())).toBe(
      true,
    );
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const pass = await getPass(db, t.pass.id);
    const expected = await getHolderPass(db, t.pass.id, null);
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
      true,
    );
    if (!pass || !expected || !snapshot) throw new Error('Missing transfer snapshot fixture');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const wrapperRef = t.kit.ctx.ids.token(32);
    const wrapperHash = await sha256Hex(wrapperRef);
    const offeredAt = t.kit.clock.now();
    await seedHistoricalOfferRef(db, {
      refHash: wrapperHash,
      instanceId: snapshot.instanceId,
      operationVersion: snapshot.operationVersion,
      createdAt: offeredAt,
      expiresAt: offeredAt + 300_000,
      consumedAt: null,
      deliveredAt: null,
    });
    expect(
      await readOffer(db, wrapperHash, offeredAt, t.credentialKeysetCommitment),
    ).not.toBeNull();
    expect(
      await whileDisabledForTest(
        walletOfferFresh,
        db,
        wrapperRef,
        offeredAt,
        t.credentialKeysetCommitment,
      ),
    ).toBe(false);
    const oldRequest = await t.token();

    await startCredentialTransfer(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      pass.id,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );

    const current = await getPass(db, pass.id);
    const wallet = await readWalletPassSnapshot(db, {
      orgId: pass.orgId,
      mode: pass.mode,
      passId: pass.id,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    });
    if (!current || !wallet) throw new Error('Missing transfer state');
    expect(current.credentialGeneration).toBe(pass.credentialGeneration + 1);
    expect(wallet.transferPending).toBe(1);
    expect(await offerPassSnapshot(t.kit.ctx, current, t.credentialKeysetCommitment)).toBeNull();
    expect(await listWalletOffers(t.kit.ctx, pass.id)).toEqual([]);
    await expect(
      issueWalletOffer(t.kit.ctx, current.downloadToken, 'samsung'),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await readOffer(db, wrapperHash, t.kit.clock.now(), t.credentialKeysetCommitment),
    ).toBeNull();
    expect(
      await whileDisabledForTest(
        walletOfferFresh,
        db,
        wrapperRef,
        t.kit.clock.now(),
        t.credentialKeysetCommitment,
      ),
    ).toBe(false);
    expect(
      await consumeWalletOfferRef(db, wrapperRef, t.kit.clock.now(), t.credentialKeysetCommitment),
    ).toBeNull();
    expect(
      await findSamsungFetchSnapshot(
        db,
        await sha256Hex(t.refId),
        t.kit.clock.now(),
        t.credentialKeysetCommitment,
        true,
      ),
    ).toBeNull();
    expect(await samsungFetchSnapshotCurrent(db, snapshot, raw, t.kit.clock.now())).toBe(false);
    const now = t.kit.clock.now();
    expect(
      await claimSamsungFetch(
        db,
        snapshot,
        {
          tokenHash: 'F'.repeat(43),
          claimId: t.kit.ctx.ids.id(),
          now,
          expiresAt: now + 30_000,
        },
        raw,
      ),
    ).toBe(false);
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
        orgId: pass.orgId,
        mode: pass.mode,
        instanceId: snapshot.instanceId,
        operationVersion: snapshot.operationVersion,
        expiresAt: now + 60_000,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      }),
    ).toBeNull();
    expect((await t.call({ token: oldRequest })).status).toBe(401);
    expect(
      (
        await t.call({
          method: 'POST',
          token: await t.token({ method: 'POST' }),
          body: '{"member":"new-holder-private"}',
        })
      ).status,
    ).toBe(401);
    expect(
      await all(db, 'SELECT id FROM wallet_samsung_fetch_refs WHERE instance_id = ?', [
        snapshot.instanceId,
      ]),
    ).toEqual([{ id: snapshot.referenceId }]);
    expect(
      await all(db, 'SELECT id FROM wallet_samsung_callback_receipts WHERE instance_id = ?', [
        snapshot.instanceId,
      ]),
    ).toEqual([]);
  }, 120_000);

  it('atomically refuses a refresh if materialized pass data changes after capture', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    await run(
      db,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.description', 'changed')
      WHERE pass_id = ? AND version = (SELECT MAX(version) FROM pass_versions WHERE pass_id = ? AND version <= ?)`,
      [snapshot.passId, snapshot.passId, snapshot.passVersion],
    );
    const accepted = await claimSamsungFetch(
      db,
      snapshot,
      {
        tokenHash: 'A'.repeat(43),
        claimId: t.kit.ctx.ids.id(),
        now: t.kit.clock.now(),
        expiresAt: t.kit.clock.now() + 30_000,
      },
      raw,
    );
    expect(accepted).toBe(false);
    const row = await first<{ promoted_at: number | null }>(
      db,
      'SELECT promoted_at FROM wallet_samsung_fetch_refs WHERE id = ?',
      [snapshot.referenceId],
    );
    expect(row?.promoted_at).toBe(snapshot.promotedAt);
    expect(
      await first(db, 'SELECT token_hash FROM wallet_samsung_auth_replays WHERE token_hash = ?', [
        'A'.repeat(43),
      ]),
    ).toBeNull();
  }, 60_000);

  it('does not repeat replay claims or receipts for the same token, even with the same claim id', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const now = t.kit.clock.now();
    const claim = {
      tokenHash: 'B'.repeat(43),
      claimId: t.kit.ctx.ids.id(),
      now,
      expiresAt: now + 30_000,
    };
    expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(true);
    expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(false);
    expect(
      await claimSamsungFetch(db, snapshot, { ...claim, claimId: t.kit.ctx.ids.id() }, raw),
    ).toBe(false);
    const envelope = await encryptSecret(await loadKekRing(t.kit.env), 'untrusted', 'test');
    const postClaim = { ...claim, tokenHash: 'C'.repeat(43), claimId: t.kit.ctx.ids.id() };
    const receipt = { id: t.kit.ctx.ids.id(), signedAt: now, envelope, countryHint: 'GB' };
    expect(await claimSamsungReceipt(db, snapshot, postClaim, receipt, raw)).toBe(true);
    expect(
      await claimSamsungReceipt(db, snapshot, postClaim, { ...receipt, countryHint: 'US' }, raw),
    ).toBe(false);
    expect(
      await claimSamsungReceipt(
        db,
        snapshot,
        postClaim,
        { ...receipt, id: t.kit.ctx.ids.id(), countryHint: 'US' },
        raw,
      ),
    ).toBe(false);
    expect(
      await claimSamsungReceipt(
        db,
        snapshot,
        { ...postClaim, claimId: t.kit.ctx.ids.id() },
        { ...receipt, id: t.kit.ctx.ids.id(), countryHint: 'US' },
        raw,
      ),
    ).toBe(false);
    const receipts = await all(
      db,
      'SELECT id FROM wallet_samsung_callback_receipts WHERE instance_id = ?',
      [snapshot.instanceId],
    );
    const hints = await all<{ country_code: string }>(
      db,
      'SELECT country_code FROM wallet_samsung_country_hints WHERE ref_id = ?',
      [snapshot.referenceId],
    );
    const instance = await first<{ installation_state: string }>(
      db,
      'SELECT installation_state FROM wallet_provider_instances WHERE id = ?',
      [snapshot.instanceId],
    );
    expect(receipts).toHaveLength(1);
    expect(hints.map((hint) => hint.country_code)).toEqual(['GB']);
    expect(instance?.installation_state).toBe('unknown');
  }, 60_000);

  it('rejects replay admission and final disclosure at the exact provider-evidence expiry', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
    );
    if (!snapshot || !t.samsungRelease?.candidateId) throw new Error('Missing evidence fixture');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    const evidence = await first<{ expires_at: number }>(
      db,
      'SELECT expires_at FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
      [t.samsungRelease.candidateId],
    );
    if (!raw || !evidence) throw new Error('Missing verified evidence');
    t.kit.clock.set(evidence.expires_at);
    const now = t.kit.clock.now();
    expect(
      await claimSamsungFetch(
        db,
        snapshot,
        {
          tokenHash: 'D'.repeat(43),
          claimId: t.kit.ctx.ids.id(),
          now,
          expiresAt: now + 30_000,
        },
        raw,
      ),
    ).toBe(false);
    expect(await samsungFetchSnapshotCurrent(db, snapshot, raw, now)).toBe(false);
    expect(
      await first(db, 'SELECT token_hash FROM wallet_samsung_auth_replays WHERE token_hash = ?', [
        'D'.repeat(43),
      ]),
    ).toBeNull();
  }, 60_000);
});
