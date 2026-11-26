// 0207: the projection, successor and binding triggers accept a credential on either model. The seed bypasses the
// insert guards, so the projection triggers are pinned by their text below and the binding trigger by behaviour.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest, walletEnrolmentIssues } from './provider-policy.ts';
import { darkRows } from './release-test-fixtures.ts';
import { findEnrolmentGateRow } from './repo-enrolment-gate.ts';
import { enrol, platformSource, seedInstance } from './wallet-roundtrip-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const KEPT = /binding_immutable|wallet_enrolment_gate_/;

/** Drops the insert guards the seed writes around; the activation trigger under test and the enrolment gate stay. */
async function dropSeedGuards(db: D1Database) {
  const rows = await all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%BEFORE INSERT%'
     AND tbl_name IN ('wallet_provider_instances', 'wallet_provider_instance_operations',
       'template_candidates', 'template_approvals', 'template_releases')`,
  );
  for (const { name } of rows) if (!KEPT.test(name)) await run(db, `DROP TRIGGER ${name}`);
}

async function dropTriggers(db: D1Database, table: string) {
  for (const { name } of await all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
    [table],
  ))
    await run(db, `DROP TRIGGER ${name}`);
}

type Kind = 'legacy' | 'new-model' | 'neither';

/** A release seeded on the account (the candidate, approval and release triggers run), then a ready placeholder activated. */
async function prepare(kind: Kind) {
  const f = await setupWalletOfferKit({
    google: 'absent',
    samsung: kind === 'legacy' ? 'configured' : 'absent',
    holderEmail: 'h@example.test',
  });
  const { kit } = f;
  kit.clock.set(Date.now());
  const mode = kind === 'legacy' ? 'live' : 'test';
  await dropSeedGuards(env.DB);
  let account: { accountId: string; revision: number };
  if (kind === 'legacy') {
    const row = await first<{ id: string; revision: number }>(
      env.DB,
      "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND provider = 'samsung' AND mode = 'live'",
      [kit.org.id],
    );
    if (!row) throw new Error('Missing legacy account.');
    account = { accountId: row.id, revision: row.revision };
  } else {
    const source = await platformSource(
      f,
      'test',
      `card${kind === 'neither' ? 995 : 994}`,
      'samsung',
    );
    account = await enrol(f, kit.org.id, 'test', source, true, 'samsung');
    if (kind === 'neither') {
      await dropTriggers(env.DB, 'wallet_provider_accounts');
      await run(
        env.DB,
        'UPDATE wallet_provider_accounts SET credential_source_id = NULL, credential_id = NULL, revision = 0 WHERE id = ?',
        [account.accountId],
      );
    }
  }
  const first1 = await kit.pass({ mode, holderEmail: 'h@example.test' });
  const seeded = await seedInstance(f, first1, account, null, 1, 'samsung');
  const second = await kit.pass({ mode, holderEmail: 'h2@example.test' });
  const keyset = await requireCredentialRefKeyset(env.DB, kit.env);
  const gen = (
    await first<{ g: number }>(
      env.DB,
      'SELECT credential_generation AS g FROM passes WHERE id = ?',
      [second.id],
    )
  )?.g;
  const now = kit.clock.now();
  const instanceId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation,
      lifecycle, desired_version, created_at, updated_at, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, 'samsung', ?, 'ready', 0, ?, ?, ?)`,
    [instanceId, second.id, second.orgId, mode, gen ?? 1, now, now, keyset],
  );
  await run(
    env.DB,
    `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash,
      pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id,
      projection_release_id, account_revision, adapter_revision, policy_revision, created_at,
      credential_keyset_commitment)
     SELECT ?, ?, 1, 'upsert', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
       p.release_id, ?, ?, 1, 1, ?, ? FROM passes p WHERE p.id = ?`,
    [
      operationId,
      instanceId,
      await sha256Hex(crypto.randomUUID()),
      seeded.releaseId,
      account.revision,
      now,
      keyset,
      second.id,
    ],
  );
  await dropTriggers(env.DB, 'template_candidates');
  await run(
    env.DB,
    `UPDATE template_candidates SET provider_account_epoch =
      (SELECT authority_epoch FROM wallet_provider_accounts WHERE id = ?) WHERE provider_account_id = ?`,
    [account.accountId, account.accountId],
  );
  return () =>
    run(
      env.DB,
      `UPDATE wallet_provider_instances SET lifecycle = 'active', account_id = ?, identity_projection_release_id = ?,
        desired_version = 1, desired_operation_id = ?, updated_at = ? WHERE id = ?`,
      [account.accountId, seeded.releaseId, operationId, now, instanceId],
    );
}

/** The issuance gate (the release) is not under test here; binding_immutable is. */
async function activate(kind: Kind) {
  return withoutTrigger(env.DB, 'wallet_provider_generation_binding_guard', await prepare(kind));
}

describe('credential presence in the projection and binding triggers', () => {
  it('a legacy-only account releases a projection and activates a ready placeholder', async () => {
    expect((await activate('legacy')).changes).toBeGreaterThan(0);
  });

  // With the binding guard in place (0229): a ready placeholder waits while its provider and mode are not
  // released, and activates once they are.
  it('a new-model-only account does too, once released', async () => {
    const update = await prepare('new-model');
    await darkRows(env.DB);
    await expect(update()).rejects.toThrow('provider issuance is unavailable');
    await run(env.DB, "UPDATE wallet_provider_releases SET state = 'released', changed_at = 0");
    expect((await update()).changes).toBeGreaterThan(0);
    await withoutTrigger(env.DB, 'wallet_provider_releases_dark_retired', () =>
      run(env.DB, "UPDATE wallet_provider_releases SET state = 'dark', changed_at = 0"),
    );
  });

  it('an account with neither credential is refused by the trigger', async () => {
    await expect(activate('neither')).rejects.toThrow(
      /provider (instance binding is immutable|operation)|not authorized|credential|immutable/,
    );
  });
});

describe('0207 recreated the presence test', () => {
  it.each([
    'template_provider_candidates_insert',
    'template_provider_approvals_insert',
    'template_provider_releases_insert',
    'wallet_provider_instances_successor',
    'wallet_provider_instances_binding_immutable',
  ])('%s tests either credential column', async (name) => {
    const row = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      [name],
    );
    expect(row?.sql).toMatch(
      /COALESCE\((\w+)\.credential_id, \1\.credential_source_id\) IS NOT NULL/,
    );
    expect(row?.sql).not.toMatch(/\w\.credential_id IS NOT NULL/);
  });
});

let liveSource: Awaited<ReturnType<typeof platformSource>> | undefined;

describe('a migrated account (legacy envelope and a source) follows Off, Held and On', () => {
  async function migrated(state: 'off' | 'held' | 'on') {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'configured',
      holderEmail: 'h@example.test',
    });
    const { kit } = f;
    kit.clock.set(Date.now());
    // One platform credential serves every org of the mode.
    liveSource ??= await platformSource(f, 'live', 'card996', 'samsung');
    const source = liveSource;
    await dropTriggers(env.DB, 'wallet_provider_accounts');
    const now = kit.clock.now();
    await run(
      env.DB,
      `UPDATE wallet_provider_accounts SET credential_source_id = ?, enrolment_revision = 1, enabled_at = ?,
        platform_hold_at = ? WHERE org_id = ? AND provider = 'samsung' AND mode = 'live'`,
      [source.id, state === 'off' ? null : now, state === 'held' ? now : null, kit.org.id],
    );
    const row = await first<{ id: string; revision: number }>(
      env.DB,
      "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND provider = 'samsung' AND mode = 'live'",
      [kit.org.id],
    );
    if (!row) throw new Error('Missing account.');
    return { f, account: { accountId: row.id, revision: row.revision } };
  }

  it.each([
    ['off', false],
    ['held', false],
    ['on', true],
  ] as const)('%s: issues %s', async (state, issues) => {
    const { f, account } = await migrated(state);
    const gate = await findEnrolmentGateRow(env.DB, 'samsung', f.kit.org.id, 'live');
    expect(walletEnrolmentIssues(gate)).toBe(issues);
    // The database agrees: an instance on the account is refused while it is Off or Held.
    await dropSeedGuards(env.DB);
    const pass = await f.kit.pass({ mode: 'live', holderEmail: 'h@example.test' });
    const seeding = seedInstance(f, pass, account, null, 1, 'samsung');
    if (issues) await expect(seeding).resolves.toBeDefined();
    else await expect(seeding).rejects.toThrow(/provider enrolment is not on/);
  });
});
