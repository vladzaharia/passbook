// 0112 on a live Samsung instance: the unretired-instance rules and the credential_version_id pins.
import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import {
  credential,
  db,
  ident,
  refused,
  revokeCredential,
  rotate,
  seedOrg,
  uid,
} from './repo-wallet-credentials-test-fixtures.ts';
import {
  type Acct,
  enrolment,
  revokeEnrolment,
  setSource,
} from './repo-wallet-enrolments-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

async function seed() {
  const t = await setupSamsungCallbacks();
  const row = await first<{ account_id: string; org_id: string; release: string }>(
    db(),
    'SELECT account_id, org_id, identity_projection_release_id AS release FROM wallet_provider_instances WHERE id = ?',
    [t.operation.instanceId],
  );
  const a: Acct = {
    id: row?.account_id ?? '',
    orgId: row?.org_id ?? '',
    mode: 'live',
    provider: 'samsung',
  };
  return { a, instanceId: t.operation.instanceId, release: row?.release ?? '', refHash: '' };
}

const opSql = `INSERT INTO wallet_provider_instance_operations
  (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
   lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
   policy_revision, credential_keyset_commitment, state, attempts, created_at, credential_version_id,
   pass_row_version, account_epoch)
  SELECT ?, o.instance_id, (SELECT MAX(v.version) + 1 FROM wallet_provider_instance_operations v WHERE v.instance_id = o.instance_id),
    o.kind, ?, o.pass_version, o.pass_revision, o.pass_credential_generation, o.lifecycle_generation,
    o.issuing_release_id, o.projection_release_id, o.account_revision, o.adapter_revision, o.policy_revision,
    o.credential_keyset_commitment, 'pending', 0, o.created_at, ?,
    (SELECT p.row_version FROM passes p JOIN wallet_provider_instances i ON i.pass_id = p.id WHERE i.id = o.instance_id),
    (SELECT a.authority_epoch FROM wallet_provider_accounts a JOIN wallet_provider_instances i ON i.account_id = a.id WHERE i.id = o.instance_id)
  FROM wallet_provider_instance_operations o WHERE o.instance_id = ? AND o.version = 1`;
// The operation guard and the release rule (0229) refuse an upsert on an account that is Off or not released; the
// pin guards are under test here.
const insertOp = (instanceId: string, pin: string | null) =>
  withoutTrigger(db(), 'wallet_provider_generation_operation_guard', () =>
    withoutTrigger(db(), 'wallet_provider_generation_operation_draining', () =>
      run(db(), opSql, [uid(), ident(), pin, instanceId]),
    ),
  );

/** A retired copy of the instance's reference under the 0043 guard, which allows no new reference. */
const refSql = `INSERT INTO wallet_samsung_fetch_refs
  (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at, retired_at, credential_keyset_commitment,
   kek_version, iv, wrapped_dek, ciphertext, credential_version_id)
  SELECT ?, ?, r.instance_id, r.created_at, r.last_offered_at, r.initial_expires_at, r.created_at,
    r.credential_keyset_commitment, r.kek_version, r.iv, r.wrapped_dek, r.ciphertext, ?
  FROM wallet_samsung_fetch_refs r WHERE r.instance_id = ? AND r.id = (
    SELECT MIN(x.id) FROM wallet_samsung_fetch_refs x WHERE x.instance_id = r.instance_id)`;
// The 0208 enrolment gate refuses a reference on an account that is not enabled; the pin guards are under test here.
const insertRef = (instanceId: string, hash: string, pin: string | null) =>
  withoutTrigger(db(), 'wallet_enrolment_gate_samsung_ref_insert', () =>
    withoutTrigger(db(), 'wallet_provider_generation_samsung_ref', () =>
      run(db(), refSql, [uid(), hash, pin, instanceId]),
    ),
  );

const tombstoneSql = `INSERT INTO wallet_samsung_tombstones
  (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id, provider_identity_hash, retired_at,
   credential_keyset_commitment, credential_version_id)
  SELECT ?, a.org_id, a.mode, a.id, a.revision, r.candidate_id, r.id, ?, 1, NULL, ?
  FROM wallet_provider_accounts a, template_releases r WHERE a.id = ? AND r.id = ?`;
const insertTombstone = (a: Acct, release: string, hash: string, pin: string | null) =>
  withoutTrigger(db(), 'wallet_samsung_tombstones_approved_insert', () =>
    withoutTrigger(db(), 'wallet_samsung_tombstone_keyset_insert', () =>
      run(db(), tombstoneSql, [hash, ident(), pin, a.id, release]),
    ),
  );

describe('an unretired instance', () => {
  it('blocks a revoke of its source and an identity change; a same-identity switch passes', async () => {
    const { a } = await seed();
    const shared = ident();
    // The org credential first: the platform may take an unverified org identity, not the reverse.
    const own = await credential({ orgId: a.orgId, provider: 'samsung', identity: shared });
    const platform = await credential({ scope: 'platform', provider: 'samsung', identity: shared });
    await setSource(a, own);
    await refused(revokeCredential(own.id), /wallet credential is in use/);
    await setSource(a, platform);
    await refused(revokeCredential(platform.id, 'platform'), /wallet credential is in use/);
    await revokeCredential(own.id);
    const different = await credential({ orgId: a.orgId, provider: 'samsung' });
    await refused(setSource(a, different), /identity change needs retired instances/);
  });
});

describe('a new-model enrolment', () => {
  it('cannot be revoked while an instance on it is unretired', async () => {
    const { a, instanceId } = await seed();
    const fresh = await enrolment(a.orgId, 'test', 'samsung');
    await withoutTrigger(db(), 'wallet_provider_instances_binding_immutable', () =>
      run(db(), 'UPDATE wallet_provider_instances SET account_id = ? WHERE id = ?', [
        fresh.id,
        instanceId,
      ]),
    );
    await refused(revokeEnrolment(fresh), /enrolment is in use/);
  });
});

describe('credential_version_id pins', () => {
  it('an op or reference pins a version of the enrolment source; NULL is legacy and only without a source', async () => {
    const { a, instanceId } = await seed();
    const own = await credential({ orgId: a.orgId, provider: 'samsung' });
    const { org } = await seedOrg();
    const foreign = await credential({ orgId: org.id, provider: 'samsung' });
    await insertOp(instanceId, null);
    await refused(insertOp(instanceId, own.versionId), /pin must belong to the enrolment source/);
    await setSource(a, own);
    await refused(insertOp(instanceId, null), /pin must belong to the enrolment source/);
    await refused(
      insertOp(instanceId, foreign.versionId),
      /pin must belong to the enrolment source/,
    );
    await insertOp(instanceId, own.versionId);
    // An older version of the same credential still belongs to it: a rotation keeps history locatable.
    const newer = await rotate(own);
    await insertOp(instanceId, newer);
    await insertOp(instanceId, own.versionId);
    await refused(
      run(
        db(),
        'UPDATE wallet_provider_instance_operations SET credential_version_id = NULL WHERE credential_version_id = ?',
        [own.versionId],
      ),
      /pin is immutable/,
    );
    await refused(insertRef(instanceId, ident(), null), /pin must belong to the enrolment source/);
    await refused(
      insertRef(instanceId, ident(), foreign.versionId),
      /pin must belong to the enrolment source/,
    );
    await insertRef(instanceId, ident(), own.versionId);
    await refused(
      run(
        db(),
        'UPDATE wallet_samsung_fetch_refs SET credential_version_id = ? WHERE credential_version_id = ?',
        [newer, own.versionId],
      ),
      /pin is immutable/,
    );
  });

  it('an operation cannot move to another instance and take its pin along', async () => {
    const { a, instanceId } = await seed();
    const own = await credential({ orgId: a.orgId, provider: 'samsung' });
    await setSource(a, own);
    await insertOp(instanceId, own.versionId);
    await refused(
      run(
        db(),
        'UPDATE wallet_provider_instance_operations SET instance_id = ? WHERE credential_version_id = ?',
        [uid(), own.versionId],
      ),
      /immutable/, // the recreated snapshot guard (0137) now fires before the pin guard
    );
  });

  it('a tombstone copies the pin of its reference', async () => {
    const { a, instanceId, release } = await seed();
    const own = await credential({ orgId: a.orgId, provider: 'samsung' });
    await setSource(a, own);
    const pinned = ident();
    await insertRef(instanceId, pinned, own.versionId);
    await refused(insertTombstone(a, release, pinned, null), /copies the pin of its reference/);
    await refused(
      insertTombstone(a, release, pinned, await rotate(own)),
      /copies the pin of its reference/,
    );
    await insertTombstone(a, release, pinned, own.versionId);
    // No reference to copy from: only NULL.
    await refused(
      insertTombstone(a, release, ident(), own.versionId),
      /copies the pin of its reference/,
    );
    await insertTombstone(a, release, ident(), null);
    expect(
      await first(
        db(),
        'SELECT credential_version_id AS v FROM wallet_samsung_tombstones WHERE ref_hash = ?',
        [pinned],
      ),
    ).toEqual({ v: own.versionId });
  });
});
