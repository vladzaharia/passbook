// A Samsung tombstone verifies from the credential version its reference was made under: after a certificate
// rotation (later versions of the same credential) and after the enrolment switches source.
import { importPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { readSamsungIssuedRefVerification } from './account-credential-historical.ts';
import {
  addRealVersion,
  cardMapOf,
  realCredential,
  samsungSecret,
} from './account-credential-test-fixtures.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstance,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  requestWalletRetirement,
} from './instance.ts';
import { onWalletPassRetired } from './lifecycle.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { setSource } from './repo-wallet-enrolments-test-fixtures.ts';
import { samsungCardMap } from './samsung-cards.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const keyOf = async (identity: { privateKey: string }) =>
  (await importPKCS8(identity.privateKey, 'RS256')) as CryptoKey;

describe('Samsung tombstone and credential versions', () => {
  it('an issued ref of type X verifies with type X card, never type Y card', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const credentials = { ...t.samsung, cardIds: { loyalty: 'cardL', ticket: 'cardT' } };
    const cards = JSON.stringify(await samsungCardMap(credentials));
    const acct = {
      id: t.operation.accountId,
      orgId: t.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const own = await realCredential(
      t.kit.env,
      { orgId: acct.orgId, provider: 'samsung' },
      { provider: 'samsung', credentials },
      cards,
    );
    await setSource(acct, own);
    await withoutTrigger(db, 'wallet_samsung_ref_credential_version_immutable', () =>
      run(db, 'UPDATE wallet_samsung_fetch_refs SET credential_version_id = ? WHERE id = ?', [
        own.currentId,
        t.referenceId,
      ]),
    );
    const revision = (
      await first<{ revision: number }>(
        db,
        'SELECT revision FROM wallet_provider_accounts WHERE id = ?',
        [acct.id],
      )
    )?.revision;
    const cardOf = async (type: string) => {
      await withoutTrigger(db, 'wallet_provider_instances_card_type_immutable', () =>
        run(db, 'UPDATE wallet_provider_instances SET card_type = ? WHERE id = ?', [
          type,
          t.operation.instanceId,
        ]),
      );
      return (
        await readSamsungIssuedRefVerification(t.kit.ctx, {
          orgId: acct.orgId,
          mode: acct.mode,
          accountId: acct.id,
          accountRevision: revision ?? 0,
          refHash: await sha256Hex(t.refId),
          credentialKeysetCommitment: t.credentialKeysetCommitment,
        })
      )?.cardId;
    };
    expect(await cardOf('loyalty')).toBe('cardL');
    expect(await cardOf('ticket')).toBe('cardT');
    // A type without its own card gets the default card, not another type's.
    expect(await cardOf('coupon')).toBe(t.samsung.cardId);
  });

  it('an issued ref is followed only by later versions of its own card', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const cards = await cardMapOf(t.samsung.cardId);
    const acct = {
      id: t.operation.accountId,
      orgId: t.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const own = await realCredential(
      t.kit.env,
      { orgId: acct.orgId, provider: 'samsung' },
      { provider: 'samsung', credentials: t.samsung },
      cards,
    );
    await setSource(acct, own);
    await withoutTrigger(db, 'wallet_samsung_ref_credential_version_immutable', () =>
      run(db, 'UPDATE wallet_samsung_fetch_refs SET credential_version_id = ? WHERE id = ?', [
        own.currentId,
        t.referenceId,
      ]),
    );
    const revision = (
      await first<{ revision: number }>(
        db,
        'SELECT revision FROM wallet_provider_accounts WHERE id = ?',
        [acct.id],
      )
    )?.revision;
    const read = async () =>
      readSamsungIssuedRefVerification(t.kit.ctx, {
        orgId: acct.orgId,
        mode: acct.mode,
        accountId: acct.id,
        accountRevision: revision ?? 0,
        refHash: await sha256Hex(t.refId),
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      });
    expect((await read())?.later).toHaveLength(0);
    // A later version of the same card (a certificate rotation) follows the ref.
    const rotated = await createFixtureIdentity(undefined, { now: new Date(t.kit.clock.now()) });
    await addRealVersion(
      t.kit.env,
      own,
      await samsungSecret(t.samsung.partnerId, t.samsung.cardId, rotated),
      cards,
    );
    expect((await read())?.later).toHaveLength(1);
    // A later version naming another card does not.
    await addRealVersion(
      t.kit.env,
      own,
      await samsungSecret(t.samsung.partnerId, 'other-card', rotated),
      JSON.stringify({
        ...JSON.parse(cards),
        coupon: await sha256Hex('other-card'),
      }),
    );
    expect((await read())?.later).toHaveLength(1);
  });

  it('verifies after a certificate rotation and after a source switch, never with an unrelated version', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const cards = await cardMapOf(t.samsung.cardId);
    const acct = {
      id: t.operation.accountId,
      orgId: t.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    // The enrolment's source holds the secret the fixture configured; the card's identity is unchanged.
    const own = await realCredential(
      t.kit.env,
      { orgId: acct.orgId, provider: 'samsung' },
      { provider: 'samsung', credentials: t.samsung },
      cards,
    );
    await setSource(acct, own);
    // The reference was made under that version (a seed: the fixture predates the pins).
    await withoutTrigger(db, 'wallet_samsung_ref_credential_version_immutable', () =>
      run(db, 'UPDATE wallet_samsung_fetch_refs SET credential_version_id = ? WHERE id = ?', [
        own.currentId,
        t.referenceId,
      ]),
    );

    const scope = {
      orgId: acct.orgId,
      mode: acct.mode,
      provider: acct.provider,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const pass = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    if (!pass) throw new Error('Missing retirement fixture');
    expect(
      await requestWalletRetirement(db, {
        ...scope,
        instanceId: t.operation.instanceId,
        version: t.operation.version,
        now: t.kit.clock.now(),
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        lifecycleGeneration: pass.lifecycleGeneration,
        issuingReleaseId: pass.issuingReleaseId,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    ).toBe(true);
    await onWalletPassRetired(t.kit.ctx, {
      orgId: scope.orgId,
      mode: scope.mode,
      passId: pass.passId,
      passVersion: pass.passVersion,
      passRevision: pass.passRevision,
      lifecycleGeneration: pass.lifecycleGeneration,
      passCredentialGeneration: pass.credentialGeneration,
      credentialKeysetCommitment: pass.credentialKeysetCommitment,
    });
    const retiring = await getWalletInstance(db, { ...scope, passId: pass.passId });
    if (!retiring) throw new Error('Missing revoke operation');
    // The op writer pinned the source's current version (the pin trigger refuses a NULL for a sourced enrolment).
    expect(
      await first(
        db,
        "SELECT credential_version_id AS pin FROM wallet_provider_instance_operations WHERE instance_id = ? AND kind = 'revoke'",
        [retiring.id],
      ),
    ).toEqual({ pin: own.currentId });
    const claim = {
      ...scope,
      instanceId: retiring.id,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(
      await persistSamsungTombstone(t.kit.ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        instanceId: retiring.id,
        operationVersion: retiring.desiredVersion,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      }),
    ).toBe(true);
    // The tombstone copied its reference's pin.
    expect(
      await first(
        db,
        'SELECT credential_version_id AS pin FROM wallet_samsung_tombstones WHERE org_id = ?',
        [scope.orgId],
      ),
    ).toEqual({ pin: own.currentId });

    const status = async (signing?: CryptoKey) =>
      (await t.call({ token: await t.token(signing ? { signingKey: signing } : {}) })).status;
    expect(await status()).toBe(204);

    // Certificate rotation: a later version of the same credential, with a new Samsung certificate.
    const rotated = await createFixtureIdentity(undefined, { now: new Date(t.kit.clock.now()) });
    await addRealVersion(
      t.kit.env,
      own,
      await samsungSecret(t.samsung.partnerId, t.samsung.cardId, rotated),
      cards,
    );
    // The secret keeps the certificate id of the fixture, as a rotation does.
    expect(await status(await keyOf(rotated))).toBe(204);
    expect(await status()).toBe(204);

    // Source switch to the platform credential of the same identity, with yet another certificate.
    const platformIdentity = await createFixtureIdentity(undefined, {
      now: new Date(t.kit.clock.now()),
    });
    const platform = await realCredential(
      t.kit.env,
      { scope: 'platform', provider: 'samsung' },
      await samsungSecret(t.samsung.partnerId, t.samsung.cardId, platformIdentity),
      cards,
    );
    await setSource(acct, platform);
    expect(await status()).toBe(204);
    expect(await status(await keyOf(rotated))).toBe(204);
    // The new source is not in the tombstone's chain: its certificate does not authenticate the old ref.
    expect(await status(await keyOf(platformIdentity))).toBe(401);
  });
});
