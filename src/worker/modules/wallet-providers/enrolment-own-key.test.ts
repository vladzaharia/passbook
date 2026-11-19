// A1: the enrolment's HMAC key has its own home on the account row, written with the first source event.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { fromBase64Url } from '../../platform/ids.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { moveRows, selectEnvelopes } from '../keys/repo-rewrap.ts';
import { planPlace } from '../keys/rewrap-plan.ts';
import { accountHmacKind, PLACES } from '../keys/rewrap-tables.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { saveOrgCredential, savePlatformCredential } from './credential-service.ts';
import { setEnrolmentSource } from './enrolment-service.ts';
import { googleObjectIds } from './google-ids.ts';
import { googleOrg } from './shared-issuer-isolation-test-fixtures.ts';
import { type Kit, kit, type Mode } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
let keyset = '';
beforeAll(async () => {
  k = await kit();
  keyset = await ensureCredentialRefKeyset(env.DB, k.env);
}, 30_000);

const ids = (issuer: string, key: Uint8Array, orgId: string, mode: Mode) =>
  googleObjectIds(issuer, key, {
    tenantId: orgId,
    mode,
    releaseId: 'r1',
    passId: 'p1',
    credentialGeneration: 1,
  });

/** A brand-new enrolment through WA1b: its own org credential as the source, no legacy envelope. */
let issuers = 0;
async function enrol(mode: Mode) {
  const issuer = String(555_000_000 + ++issuers);
  const org = await k.org();
  const m = await k.member(org.id, mode);
  await saveOrgCredential(k.ctx, m.auth, org.id, {
    provider: 'google',
    expectedRevision: 0,
    credentials: k.google(issuer),
  });
  const view = await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
    source: 'org',
    expectedRevision: 0,
  });
  if (!view.accountId) throw new Error('Missing enrolment.');
  return { org, m, accountId: view.accountId, issuer };
}

const verify = (
  e: { org: { id: string }; accountId: string },
  mode: Mode,
  ctx: ServiceContext = k.ctx,
) =>
  readGoogleCallbackVerification(ctx, {
    orgId: e.org.id,
    mode,
    accountId: e.accountId,
    accountRevision: 1,
    credentialKeysetCommitment: keyset,
  });

const row = (accountId: string) =>
  first<{
    credential_id: string | null;
    hmac_kek_version: number | null;
    hmac_iv: ArrayBuffer;
    hmac_wrapped_dek: ArrayBuffer;
    hmac_ciphertext: ArrayBuffer;
  }>(env.DB, 'SELECT * FROM wallet_provider_accounts WHERE id = ?', [accountId]);

describe('the enrolment own key', () => {
  it('a brand-new enrolment resolves end to end; WA1b writes what WA1c reads', async () => {
    const e = await enrol('test');
    const stored = await row(e.accountId);
    expect(stored?.credential_id).toBeNull();
    expect(stored?.hmac_kek_version).toBe(1);
    const v = await verify(e, 'test');
    expect(v?.issuerId).toBe(e.issuer);
    expect(v?.objectIdHmacKey).toHaveLength(32);
    // The ids derive from the key in the enrolment's own columns.
    const own = await loadKekRing(k.env).then(async (ring) =>
      fromBase64Url(
        new TextDecoder().decode(
          await (await import('../../platform/crypto.ts')).decryptSecret(
            ring,
            {
              kekVersion: stored?.hmac_kek_version ?? 0,
              iv: new Uint8Array(stored?.hmac_iv ?? new ArrayBuffer(0)),
              wrappedDek: new Uint8Array(stored?.hmac_wrapped_dek ?? new ArrayBuffer(0)),
              ciphertext: new Uint8Array(stored?.hmac_ciphertext ?? new ArrayBuffer(0)),
            },
            credentialAad(e.accountId, e.org.id, accountHmacKind(e.accountId, 'test', 'google')),
          ),
        ),
      ),
    );
    expect(await ids(e.issuer, v?.objectIdHmacKey ?? new Uint8Array(), e.org.id, 'test')).toEqual(
      await ids(e.issuer, own, e.org.id, 'test'),
    );
    // Switching the source later keeps the key.
    const platform = await first<{ revision: number }>(
      env.DB,
      "SELECT revision FROM wallet_credentials WHERE scope = 'platform' AND mode = 'test' AND provider = 'google' AND revoked_at IS NULL",
    );
    await savePlatformCredential(k.ctx, (await k.admin()).auth, {
      mode: 'test',
      provider: 'google',
      expectedRevision: platform?.revision ?? 0,
      credentials: k.google('777000222'),
    });
    await setEnrolmentSource(k.ctx, e.m.auth, e.org.id, 'google', {
      source: 'platform',
      expectedRevision: 1,
    });
    expect((await row(e.accountId))?.hmac_ciphertext).toEqual(stored?.hmac_ciphertext);
  });

  it('differs per enrolment and per mode', async () => {
    const [a, b, c] = [await enrol('test'), await enrol('test'), await enrol('live')];
    const keys = await Promise.all([verify(a, 'test'), verify(b, 'test'), verify(c, 'live')]);
    const hex = keys.map((v) => Buffer.from(v?.objectIdHmacKey ?? []).toString('hex'));
    expect(new Set(hex).size).toBe(3);
    // Same issuer, so only the key separates the ids.
    const [x, y] = await Promise.all(
      [0, 1].map((i) => ids(a.issuer, keys[i]?.objectIdHmacKey ?? new Uint8Array(), 'o', 'test')),
    );
    expect(x?.objectId).not.toBe(y?.objectId);
  });

  it('is immutable once set, but a KEK rewrap may move it', async () => {
    const e = await enrol('test');
    const before = await row(e.accountId);
    const bad = (sql: string, params: unknown[] = []) =>
      expect(
        run(env.DB, `UPDATE wallet_provider_accounts SET ${sql} WHERE id = ?`, [
          ...params,
          e.accountId,
        ] as never),
      ).rejects.toThrow(/immutable wallet account hmac key/);
    await bad('hmac_ciphertext = ?', [new Uint8Array(48)]);
    await bad('hmac_iv = ?', [new Uint8Array(12)]);
    await bad(
      'hmac_kek_version = NULL, hmac_iv = NULL, hmac_wrapped_dek = NULL, hmac_ciphertext = NULL',
    );
    await bad('hmac_kek_version = 1, hmac_wrapped_dek = ?', [new Uint8Array(60)]);
    await bad('hmac_kek_version = 2');
    expect(await row(e.accountId)).toEqual(before);
    await run(
      env.DB,
      'UPDATE wallet_provider_accounts SET hmac_kek_version = 2, hmac_wrapped_dek = ? WHERE id = ?',
      [new Uint8Array(60), e.accountId],
    );
    expect((await row(e.accountId))?.hmac_kek_version).toBe(2);
    // The columns are all or none.
    await expect(
      run(env.DB, "UPDATE wallet_provider_accounts SET hmac_iv = NULL WHERE id = 'none'"),
    ).resolves.toBeDefined();
  });

  it('rewraps under a newer KEK and still resolves', async () => {
    const e = await enrol('test');
    const before = await verify(e, 'test');
    const two = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const ctx2 = createServiceContext({ ...k.env, KEK_V2: two });
    const place = PLACES.find((p) => p.table === 'wallet_provider_accounts');
    if (!place) throw new Error('place');
    const ring = await loadKekRing(ctx2.env);
    const rows = (await selectEnvelopes(env.DB, place.table, null, ring.current, 500)).filter(
      (r) => r.pk === e.accountId,
    );
    expect(rows).toHaveLength(1);
    const plan = await planPlace(ring, place.aad, rows);
    expect(plan.unreadable).toEqual([]);
    expect(await moveRows(env.DB, { table: place.table, moves: plan.moves })).toBe(1);
    expect((await row(e.accountId))?.hmac_kek_version).toBe(ring.current);
    const after = await verify(e, 'test', ctx2);
    expect(after?.objectIdHmacKey).toEqual(before?.objectIdHmacKey);
    // An envelope read for another AAD (account) does not open.
    const other = await enrol('test');
    const swapped = await selectEnvelopes(env.DB, place.table, null, ring.current, 500);
    const mine = swapped.find((r) => r.pk === other.accountId);
    if (!mine) throw new Error('row');
    expect((await planPlace(ring, place.aad, [{ ...mine, pk: e.accountId }])).unreadable).toEqual([
      e.accountId,
    ]);
  });

  it('a legacy row still resolves from its envelope, and prefers the own key once copied', async () => {
    const o = await googleOrg(env.DB);
    const legacy = await readGoogleCallbackVerification(o.kit.ctx, {
      orgId: o.orgId,
      mode: 'live',
      accountId: o.account.id,
      accountRevision: o.account.revision,
      credentialKeysetCommitment: await ensureCredentialRefKeyset(o.kit.env.DB, o.kit.env),
    });
    expect(legacy?.objectIdHmacKey).toHaveLength(32);
    const key = 'A'.repeat(43);
    const envelope = await encryptSecret(
      await loadKekRing(o.kit.env),
      key,
      credentialAad(o.account.id, o.orgId, accountHmacKind(o.account.id, 'live', 'google')),
    );
    await run(
      o.kit.env.DB,
      `UPDATE wallet_provider_accounts SET hmac_kek_version = ?, hmac_iv = ?, hmac_wrapped_dek = ?, hmac_ciphertext = ? WHERE id = ?`,
      [envelope.kekVersion, envelope.iv, envelope.wrappedDek, envelope.ciphertext, o.account.id],
    );
    const after = await readGoogleCallbackVerification(o.kit.ctx, {
      orgId: o.orgId,
      mode: 'live',
      accountId: o.account.id,
      accountRevision: o.account.revision,
      credentialKeysetCommitment: await ensureCredentialRefKeyset(o.kit.env.DB, o.kit.env),
    });
    expect(after?.objectIdHmacKey).toEqual(fromBase64Url(key));
    expect(after?.issuerId).toBe(legacy?.issuerId);
  });
});
