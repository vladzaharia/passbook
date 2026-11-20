// PE3: wallet_provider_accounts.authority_epoch and wallet_provider_instances.instance_epoch (0133).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makePass, makeTemplate, withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { storedIdentityHash } from './account-credential-material.ts';
import { configureWalletProviderAccount, revokeWalletProviderAccount } from './account-service.ts';
import { seedLegacy } from './credential-migrate-test-fixtures.ts';
import { saveOrgCredential } from './credential-service.ts';
import { revokeEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import { findAccount } from './repo-accounts.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

const db = env.DB;
let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const epochOf = async (id: string) =>
  (
    await first<{ e: number }>(
      db,
      'SELECT authority_epoch AS e FROM wallet_provider_accounts WHERE id = ?',
      [id],
    )
  )?.e ?? -1;
const hash = (c: string) => c.repeat(64);

/** Another legacy configure at the next revision, written as the service writes it, with a chosen identity. */
async function configureRaw(accountId: string, identity: string | null) {
  const cur = await first<{ credential_id: string; revision: number; actor: string }>(
    db,
    `SELECT a.credential_id, a.revision, e.actor_id AS actor FROM wallet_provider_accounts a
     JOIN wallet_provider_account_events e ON e.account_id = a.id AND e.revision = 1 WHERE a.id = ?`,
    [accountId],
  );
  if (!cur) throw new Error('Missing account.');
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_provider_credentials
       (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, identity_hash, created_at)
       SELECT ?, c.account_id, c.org_id, c.mode, c.provider, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext, ?, ?
       FROM wallet_provider_credentials c WHERE c.id = ?`,
      [credentialId, identity, now, cur.credential_id],
    ),
    stmt(
      db,
      `INSERT INTO wallet_provider_account_events
       (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, created_at)
       SELECT ?, a.id, a.org_id, a.mode, a.provider, a.revision + 1, 'configure', ?, ?, ? FROM wallet_provider_accounts a WHERE a.id = ?`,
      [crypto.randomUUID(), credentialId, cur.actor, now, accountId],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_accounts SET credential_id = ?, revoked_at = NULL, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      [credentialId, now, accountId],
    ),
  ]);
}

async function revokeRaw(accountId: string) {
  const now = Date.now();
  await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_provider_account_events
       (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, created_at)
       SELECT ?, a.id, a.org_id, a.mode, a.provider, a.revision + 1, 'revoke', a.credential_id, e.actor_id, ?
       FROM wallet_provider_accounts a JOIN wallet_provider_account_events e ON e.account_id = a.id AND e.revision = 1
       WHERE a.id = ?`,
      [crypto.randomUUID(), now, accountId],
    ),
    stmt(
      db,
      'UPDATE wallet_provider_accounts SET revoked_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      [now, now, accountId],
    ),
  ]);
}

const auditRows = async (accountId: string) =>
  (
    await all<{ action: string }>(
      db,
      "SELECT action FROM audit_log WHERE target_type = 'wallet_provider_account' AND target_id = ? ORDER BY at, rowid",
      [accountId],
    )
  ).map((r) => r.action);

describe('account authority_epoch (legacy credentials)', () => {
  it('moves on an identity change, a NULL identity and a revoke, not on a same-identity rotation', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google());
    const base = await epochOf(a.id);
    expect(base, 'the seed configures from no credential').toBe(2);

    await configureRaw(a.id, hash('a'));
    expect(await epochOf(a.id), 'from a NULL identity').toBe(base + 1);
    await configureRaw(a.id, hash('a'));
    await configureRaw(a.id, hash('a'));
    expect(await epochOf(a.id), 'same identity').toBe(base + 1);
    await configureRaw(a.id, hash('b'));
    expect(await epochOf(a.id), 'identity changed').toBe(base + 2);
    await configureRaw(a.id, null);
    expect(await epochOf(a.id), 'to a NULL identity').toBe(base + 3);
    await configureRaw(a.id, hash('b'));
    expect(await epochOf(a.id), 'from a NULL identity').toBe(base + 4);
    await revokeRaw(a.id);
    expect(await epochOf(a.id), 'revoke').toBe(base + 5);
    await configureRaw(a.id, hash('b'));
    expect(await epochOf(a.id), 'reconfigure clears revoked_at').toBe(base + 6);
  });

  it('leaves the transition and audit triggers firing once per revision', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'test', 'samsung', k.samsung());
    await configureRaw(a.id, hash('c'));
    await configureRaw(a.id, hash('d'));
    await revokeRaw(a.id);
    // The seed's configure, two more configures and the revoke: one audit row each, and revision counts them.
    expect(await auditRows(a.id)).toEqual([
      'wallet_provider.account_configure',
      'wallet_provider.account_configure',
      'wallet_provider.account_configure',
      'wallet_provider.account_revoke',
    ]);
    expect(
      (
        await first<{ r: number }>(
          db,
          'SELECT revision AS r FROM wallet_provider_accounts WHERE id = ?',
          [a.id],
        )
      )?.r,
    ).toBe(4);
  });

  it('is monotonic and volatile columns leave it alone', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'samsung', k.samsung());
    await configureRaw(a.id, hash('e'));
    const before = await epochOf(a.id);
    await expect(
      run(db, 'UPDATE wallet_provider_accounts SET authority_epoch = ? WHERE id = ?', [
        before - 1,
        a.id,
      ]),
    ).rejects.toThrow(/epoch_monotonic/);
    await run(db, 'UPDATE wallet_provider_accounts SET authority_epoch = ? WHERE id = ?', [
      before + 5,
      a.id,
    ]);
    expect(await epochOf(a.id)).toBe(before + 5);
    // Volatile columns never move it.
    await run(db, 'UPDATE wallet_provider_accounts SET updated_at = updated_at + 1 WHERE id = ?', [
      a.id,
    ]);
    expect(await epochOf(a.id)).toBe(before + 5);
  });

  it('keeps identity_hash write-once on a credential', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google());
    await configureRaw(a.id, hash('f'));
    const cred = await first<{ credential_id: string }>(
      db,
      'SELECT credential_id FROM wallet_provider_accounts WHERE id = ?',
      [a.id],
    );
    await expect(
      run(db, 'UPDATE wallet_provider_credentials SET identity_hash = ? WHERE id = ?', [
        hash('0'),
        cred?.credential_id,
      ]),
    ).rejects.toThrow(/immutable wallet provider credential/);
    await expect(
      run(db, "UPDATE wallet_provider_credentials SET identity_hash = 'x' WHERE id = ?", [
        cred?.credential_id,
      ]),
    ).rejects.toThrow();
  });
});

describe('account authority_epoch (service)', () => {
  it('writes identity_hash with each configure; a rotation keeps the epoch and a revoke moves it', async () => {
    const org = await k.org();
    const m = await k.member(org.id, 'live');
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    await configureWalletProviderAccount(k.ctx, m.auth, {
      ...scope,
      expectedRevision: 0,
      credentials: k.google(),
    });
    const row = await findAccount(db, scope);
    if (!row) throw new Error('Missing account.');
    expect(row.authority_epoch, 'a first configure has no old credential').toBe(2);
    const identity = await storedIdentityHash({
      version: 1,
      provider: 'google',
      credentials: k.google(),
      objectIdHmacKey: '',
    });
    const identities = async () =>
      (
        await all<{ identity_hash: string | null }>(
          db,
          'SELECT identity_hash FROM wallet_provider_credentials WHERE account_id = ? ORDER BY created_at, rowid',
          [row.id],
        )
      ).map((c) => c.identity_hash);
    expect(await identities()).toEqual([identity]);

    await configureWalletProviderAccount(k.ctx, m.auth, {
      ...scope,
      expectedRevision: 1,
      credentials: k.google(),
    });
    expect(await identities()).toEqual([identity, identity]);
    expect((await findAccount(db, scope))?.authority_epoch, 'rotation').toBe(2);

    await revokeWalletProviderAccount(k.ctx, m.auth, { ...scope, expectedRevision: 2 });
    expect((await findAccount(db, scope))?.authority_epoch, 'revoke').toBe(3);
  });

  it('hashes a Samsung credential by partner and default card', async () => {
    const org = await k.org();
    const m = await k.member(org.id, 'test');
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'samsung' as const };
    await configureWalletProviderAccount(k.ctx, m.auth, {
      ...scope,
      expectedRevision: 0,
      credentials: k.samsung(),
    });
    const row = await findAccount(db, scope);
    const stored = await first<{ identity_hash: string }>(
      db,
      'SELECT identity_hash FROM wallet_provider_credentials WHERE account_id = ?',
      [row?.id],
    );
    expect(stored?.identity_hash).toBe(
      await storedIdentityHash({ version: 1, provider: 'samsung', credentials: k.samsung() }),
    );
    expect(stored?.identity_hash).not.toBe(
      await storedIdentityHash({
        version: 1,
        provider: 'samsung',
        credentials: k.samsung('other'),
      }),
    );
  });
});

describe('account authority_epoch (enrolments)', () => {
  it('moves when the first source sets the identity and when the enrolment is revoked', async () => {
    const org = await k.org();
    const m = await k.member(org.id, 'live');
    await saveOrgCredential(k.ctx, m.auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('777000111'),
    });
    const view = await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
      source: 'org',
      expectedRevision: 0,
    });
    const accountId = view.accountId ?? '';
    const before = await first<{ identity_hash: string | null }>(
      db,
      'SELECT identity_hash FROM wallet_provider_accounts WHERE id = ?',
      [accountId],
    );
    expect(before?.identity_hash).not.toBeNull();
    expect(await epochOf(accountId), 'identity NULL to set').toBe(2);
    const row = await first<{ enrolment_revision: number }>(
      db,
      'SELECT enrolment_revision FROM wallet_provider_accounts WHERE id = ?',
      [accountId],
    );
    await revokeEnrolment(k.ctx, m.auth, org.id, 'google', {
      expectedRevision: row?.enrolment_revision ?? 0,
    });
    expect(await epochOf(accountId)).toBe(3);
  });
});

describe('instance_epoch', () => {
  let n = 0;
  async function blocked() {
    const org = await k.org();
    const pass = await makePass(k.f, {
      orgId: org.id,
      template: makeTemplate({ id: `tpl-pe3-${++n}` }).resolved,
      mode: 'test',
    });
    const id = crypto.randomUUID();
    await withoutTrigger(db, 'wallet_provider_generation_insert_guard', () =>
      run(
        db,
        `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at)
         VALUES (?, ?, ?, 'test', 'google', 1, 'blocked', 0, 1, 1)`,
        [id, pass.id, org.id],
      ),
    );
    return id;
  }
  const epoch = async (id: string) =>
    (
      await first<{ e: number }>(
        db,
        'SELECT instance_epoch AS e FROM wallet_provider_instances WHERE id = ?',
        [id],
      )
    )?.e ?? -1;

  it('starts at 1, ignores volatile columns, and moves once per change of its bump set', async () => {
    const id = await blocked();
    expect(await epoch(id)).toBe(1);
    await run(
      db,
      'UPDATE wallet_provider_instances SET updated_at = 9, retirement_next_attempt_at = 7, saved_at = 3, holder_removed_at = 4 WHERE id = ?',
      [id],
    );
    expect(await epoch(id)).toBe(1);
    await run(db, 'UPDATE wallet_provider_instances SET lifecycle = lifecycle WHERE id = ?', [id]);
    expect(await epoch(id), 'a SET to the same value').toBe(1);
    await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = 5 WHERE id = ?', [
      id,
    ]);
    expect(await epoch(id)).toBe(2);
    await run(
      db,
      "UPDATE wallet_provider_instances SET lifecycle = 'retired', retirement_reason = 'not_issued', retired_at = 6 WHERE id = ?",
      [id],
    );
    expect(await epoch(id), 'three columns in one statement are one bump').toBe(3);
  });

  it('is monotonic', async () => {
    const id = await blocked();
    await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = 5 WHERE id = ?', [
      id,
    ]);
    await expect(
      run(db, 'UPDATE wallet_provider_instances SET instance_epoch = 1 WHERE id = ?', [id]),
    ).rejects.toThrow(/epoch_monotonic/);
    expect(await epoch(id)).toBe(2);
  });

  it('refuses a change of any fixed column and allows a SET to the same value', async () => {
    const id = await blocked();
    await run(
      db,
      'UPDATE wallet_provider_instances SET created_at = 1, channel_epoch = 1 WHERE id = ?',
      [id],
    );
    for (const set of [
      'created_at = 2',
      'credential_generation = 2',
      'channel_epoch = 2',
      "mode = 'live'",
      "provider = 'samsung'",
    ])
      await expect(
        run(db, `UPDATE wallet_provider_instances SET ${set} WHERE id = ?`, [id]),
        set,
      ).rejects.toThrow(/provider instance identity is immutable/);
  });
});
