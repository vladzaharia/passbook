import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { getConnection } from './repo.ts';

const db = env.DB;

async function seedConnection(extra = '', args: (string | number)[] = []) {
  const f = fixtures(await makeEnv());
  const org = await makeOrg(f);
  const id = f.ids.id();
  await run(
    db,
    `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at${extra ? `, ${extra.split('=')[0]}` : ''})
     VALUES (?, ?, 'x', 'C', 1, 1${extra ? ', ?' : ''})`,
    [id, org.id, ...args],
  );
  return { id, f };
}

describe('0102 connections recipes', () => {
  it('a connection without the new columns reads as no rules and no previous secret', async () => {
    const { id } = await seedConnection();
    const row = await getConnection(db, id);
    expect(row?.voidWhen).toEqual([]);
    expect(row?.webhookPrevCredentialId).toBeNull();
    expect(row?.webhookPrevUntil).toBeNull();
  });

  it('stores void rules and reads them back', async () => {
    const rules = [{ from: '/status', op: 'in', values: ['canceled'] }];
    const { id } = await seedConnection('void_when=', [JSON.stringify(rules)]);
    expect((await getConnection(db, id))?.voidWhen).toEqual(rules);
  });

  it('the CHECK refuses 9 rules and non-arrays', async () => {
    await expect(
      seedConnection('void_when=', [JSON.stringify(Array(9).fill({ from: '/a', op: 'present' }))]),
    ).rejects.toThrow(/CHECK/);
    await expect(seedConnection('void_when=', ['{}'])).rejects.toThrow(/CHECK/);
    await expect(seedConnection('void_when=', ['not json'])).rejects.toThrow(/CHECK/);
    await expect(
      seedConnection('void_when=', [JSON.stringify(Array(8).fill({ from: '/a', op: 'present' }))]),
    ).resolves.toBeDefined();
  });

  it('changing void_when moves the generation, the previous-secret columns do not', async () => {
    const { id } = await seedConnection();
    const gen = async () =>
      (await first<{ g: number }>(db, 'SELECT generation AS g FROM connections WHERE id = ?', [id]))
        ?.g;
    const g0 = await gen();
    await run(db, 'UPDATE connections SET webhook_prev_until = 5 WHERE id = ?', [id]);
    expect(await gen()).toBe(g0);
    await run(db, "UPDATE connections SET void_when = '[]' WHERE id = ?", [id]);
    expect(await gen()).toBeGreaterThan(g0 ?? 0);
  });

  it('the previous credential is cleared, not the connection, when its credential goes', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const id = f.ids.id();
    const cred = f.ids.id();
    await run(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, 'webhook', 1, x'00', x'00', x'00', 1)`,
      [cred, org.id],
    );
    await run(
      db,
      `INSERT INTO connections (id, org_id, connector_type, name, webhook_prev_credential_id, webhook_prev_until, created_at, updated_at)
       VALUES (?, ?, 'x', 'C', ?, 9, 1, 1)`,
      [id, org.id, cred],
    );
    await run(db, 'DELETE FROM credentials WHERE id = ?', [cred]);
    expect((await getConnection(db, id))?.webhookPrevCredentialId).toBeNull();
  });

  it('a previous credential needs its expiry', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const cred = f.ids.id();
    await run(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, 'webhook', 1, x'00', x'00', x'00', 1)`,
      [cred, org.id],
    );
    await expect(
      run(
        db,
        `INSERT INTO connections (id, org_id, connector_type, name, webhook_prev_credential_id, created_at, updated_at)
         VALUES (?, ?, 'x', 'C', ?, 1, 1)`,
        [f.ids.id(), org.id, cred],
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('connection_ref_versions cascades with its connection and refuses long refs', async () => {
    const { id } = await seedConnection();
    await run(
      db,
      'INSERT INTO connection_ref_versions (connection_id, ref, source_version, updated_at) VALUES (?, ?, 5, 1)',
      [id, 'sub_1'],
    );
    await expect(
      run(
        db,
        'INSERT INTO connection_ref_versions (connection_id, ref, source_version, updated_at) VALUES (?, ?, 5, 1)',
        [id, 'x'.repeat(201)],
      ),
    ).rejects.toThrow(/CHECK/);
    await run(db, 'DELETE FROM connections WHERE id = ?', [id]);
    expect(
      await first(db, 'SELECT 1 FROM connection_ref_versions WHERE connection_id = ?', [id]),
    ).toBeNull();
  });
});
