import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { first, run, type SqlValue } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';

const blob = (byte: number, length: number) => new Uint8Array(length).fill(byte);

async function revisions(db: D1Database) {
  return {
    sequence: await first(
      db,
      'SELECT revision FROM signing_identity_revision_sequence WHERE id = 1',
    ),
    identities: await first(
      db,
      'SELECT group_concat(id || ":" || revision) AS r FROM signing_identities',
    ),
  };
}

/** Each case: a column list, the values to set, and whether the update is allowed. */
type Case = { name: string; set: string; params: SqlValue[]; ok: boolean };

const shape = (extra: Case[]): Case[] => [
  {
    name: 'a rewrap (higher kek_version, new wrapped_dek)',
    set: 'kek_version = 2, wrapped_dek = ?',
    params: [blob(9, 60)],
    ok: true,
  },
  {
    name: 'an iv change',
    set: 'kek_version = 2, wrapped_dek = ?, iv = ?',
    params: [blob(9, 60), blob(8, 12)],
    ok: false,
  },
  {
    name: 'a ciphertext change',
    set: 'kek_version = 2, wrapped_dek = ?, ciphertext = ?',
    params: [blob(9, 60), blob(8, 40)],
    ok: false,
  },
  { name: 'the same kek_version', set: 'wrapped_dek = ?', params: [blob(9, 60)], ok: false },
  {
    name: 'a lower kek_version',
    set: 'kek_version = 0, wrapped_dek = ?',
    params: [blob(9, 60)],
    ok: false,
  },
  { name: 'a kek_version bump alone', set: 'kek_version = 2', params: [], ok: false },
  ...extra,
];

describe('rewrap-shaped updates: credentials', () => {
  async function seed() {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    const id = f.ids.id();
    await run(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, 'pass_signer', 1, ?, ?, ?, 'fp', 1)`,
      [id, org.id, blob(1, 12), blob(2, 60), blob(3, 40)],
    );
    await run(
      db,
      `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, created_at)
       VALUES (?, ?, 'L', ?, 'TEAM', 'db', ?, 1)`,
      [f.ids.id(), org.id, `pass.test.${id}`, id],
    );
    return { db, org, id, f };
  }

  it('bumps no signing identity revision for a rewrap, and still does for any other change', async () => {
    const { db, id } = await seed();
    const before = await revisions(db);
    await run(db, 'UPDATE credentials SET kek_version = 2, wrapped_dek = ? WHERE id = ?', [
      blob(9, 60),
      id,
    ]);
    expect(await revisions(db)).toEqual(before);
    expect(await first(db, 'SELECT kek_version FROM credentials WHERE id = ?', [id])).toEqual({
      kek_version: 2,
    });

    for (const set of [
      ['iv = ?', blob(7, 12)],
      ['ciphertext = ?', blob(7, 40)],
      ['kek_version = 3', null],
      ['kek_version = 1, wrapped_dek = ?', blob(6, 60)],
      ["fingerprint = 'other'", null],
      ["kind = 'connector'", null],
    ] as const) {
      const now = await revisions(db);
      await run(db, `UPDATE credentials SET ${set[0]} WHERE id = ?`, set[1] ? [set[1], id] : [id]);
      expect(await revisions(db), set[0]).not.toEqual(now);
    }
  });

  it('bumps the revision when the wrapped_dek changes with the iv, as an overwrite does', async () => {
    const { db, id } = await seed();
    const before = await revisions(db);
    await run(db, 'UPDATE credentials SET kek_version = 2, wrapped_dek = ?, iv = ? WHERE id = ?', [
      blob(9, 60),
      blob(5, 12),
      id,
    ]);
    expect(await revisions(db)).not.toEqual(before);
  });

  it('treats a rewrap of a credential with no signing identity like any other (no bump at all)', async () => {
    const { db, org, f } = await seed();
    const other = f.ids.id();
    await run(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, 'connector', 1, ?, ?, ?, 1)`,
      [other, org.id, blob(1, 12), blob(2, 60), blob(3, 40)],
    );
    const before = await revisions(db);
    await run(db, 'UPDATE credentials SET kek_version = 2, wrapped_dek = ? WHERE id = ?', [
      blob(9, 60),
      other,
    ]);
    expect(await revisions(db)).toEqual(before);
  });
});

describe('rewrap-shaped updates: wallet_provider_credentials', () => {
  async function seed() {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    const account = f.ids.id();
    const id = f.ids.id();
    await run(
      db,
      `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at)
       VALUES (?, ?, 'live', 'google', 1, 1)`,
      [account, org.id],
    );
    await run(
      db,
      `INSERT INTO wallet_provider_credentials (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, ?, 'live', 'google', 1, ?, ?, ?, 1)`,
      [id, account, org.id, blob(1, 12), blob(2, 60), blob(3, 40)],
    );
    return { db, id };
  }

  it.each(
    shape([
      {
        name: 'a created_at change',
        set: 'kek_version = 2, wrapped_dek = ?, created_at = 5',
        params: [blob(9, 60)],
        ok: false,
      },
      {
        name: 'a mode change',
        set: "kek_version = 2, wrapped_dek = ?, mode = 'test'",
        params: [blob(9, 60)],
        ok: false,
      },
    ]),
  )('$name', async ({ set, params, ok }) => {
    const { db, id } = await seed();
    const update = run(db, `UPDATE wallet_provider_credentials SET ${set} WHERE id = ?`, [
      ...params,
      id,
    ]);
    if (ok) await update;
    else await expect(update).rejects.toThrow(/immutable wallet provider credential/);
  });

  it('still refuses every delete', async () => {
    const { db, id } = await seed();
    await expect(
      run(db, 'DELETE FROM wallet_provider_credentials WHERE id = ?', [id]),
    ).rejects.toThrow(/immutable wallet provider credential/);
  });
});

describe('rewrap-shaped updates: pass_credential_transfer_payloads', () => {
  async function seed() {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    await ensureCredentialRefKeyset(f.env.DB, f.env);
    const pass = await makePass(f, { orgId: org.id, template, registry });
    const t = f.ids.id();
    await stagePendingCredentialTransfer(f.env.DB, pass.id, {
      id: t,
      token: f.ids.token(),
      now: f.clock.now(),
    });
    await withoutTrigger(f.env.DB, 'pass_credential_transfer_payload_insert_guard', () =>
      run(
        f.env.DB,
        `INSERT INTO pass_credential_transfer_payloads (transfer_id, kek_version, iv, wrapped_dek, ciphertext)
         VALUES (?, 1, ?, ?, ?)`,
        [t, blob(1, 12), blob(2, 60), blob(3, 40)],
      ),
    );
    return { db: f.env.DB, t };
  }

  it.each(
    shape([
      {
        name: 'a transfer_id change',
        set: "kek_version = 2, wrapped_dek = ?, transfer_id = 't2'",
        params: [blob(9, 60)],
        ok: false,
      },
    ]),
  )('$name', async ({ set, params, ok }) => {
    const { db, t } = await seed();
    const update = run(
      db,
      `UPDATE pass_credential_transfer_payloads SET ${set} WHERE transfer_id = ?`,
      [...params, t],
    );
    if (ok) await update;
    else await expect(update).rejects.toThrow(/credential transfer payload is immutable/);
  });

  it('still refuses a delete while the transfer is pending', async () => {
    const { db, t } = await seed();
    await expect(
      run(db, 'DELETE FROM pass_credential_transfer_payloads WHERE transfer_id = ?', [t]),
    ).rejects.toThrow(/credential transfer payload is immutable/);
  });
});
