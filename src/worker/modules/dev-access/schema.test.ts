import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { seedAuthority } from '../../platform/authority-test-fixtures.ts';
import { all, run, type SqlValue } from '../../platform/db.ts';

let seed: Awaited<ReturnType<typeof seedAuthority>>;
let n = 0;
const next = (p: string) => `${p}-${++n}`;
const freshUser = async () => (await makeUser(seed.f)).id;

/** The error message of a statement the schema refuses, or null when it ran. */
async function refused(sql: string, params: SqlValue[] = []): Promise<string | null> {
  try {
    await run(env.DB, sql, params);
    return null;
  } catch (e) {
    return String((e as Error).cause ?? e);
  }
}

function insert(table: string, row: Record<string, SqlValue>, verb = 'INSERT') {
  const cols = Object.keys(row);
  return refused(
    `${verb} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    Object.values(row),
  );
}

async function invitation(over: Record<string, SqlValue> = {}) {
  const row: Record<string, SqlValue> = {
    id: next('di'),
    org_id: seed.org.id,
    email: 'dev@example.test',
    token_hash: next('hash'),
    org_invitation_id: null,
    created_by_user: seed.user.id,
    created_by_key: null,
    created_at: 1000,
    expires_at: 2000,
    claim_until: 2000,
    ...over,
  };
  return { id: row.id as string, error: await insert('developer_invitations', row) };
}

async function sponsor(over: Record<string, SqlValue> = {}) {
  const row: Record<string, SqlValue> = {
    id: next('ds'),
    org_id: seed.org.id,
    user_id: await freshUser(),
    invitation_id: (await invitation()).id,
    idp_subject: 'sub-1',
    group_source: 'signup',
    created_at: 3000,
    ...over,
  };
  return { id: row.id as string, row, error: await insert('developer_sponsors', row) };
}

const upd = (table: string, set: string, id: string, params: SqlValue[] = []) =>
  refused(`UPDATE ${table} SET ${set} WHERE id = ?`, [...params, id]);

beforeAll(async () => {
  seed = await seedAuthority('dev-access-schema');
});

describe('developer_invitations', () => {
  it('needs exactly one creator, a claim window, and at most one end state', async () => {
    expect((await invitation()).error).toBeNull();
    const byKey = await invitation({ created_by_user: null, created_by_key: seed.key.id });
    expect(byKey.error).toBeNull();
    expect((await invitation({ created_by_user: null })).error).toMatch(/CHECK/);
    expect((await invitation({ created_by_key: seed.key.id })).error).toMatch(/CHECK/);
    expect((await invitation({ claim_until: 1999 })).error).toMatch(/CHECK/);
    const { id } = await invitation();
    const both = 'revoked_at = 5, accepted_at = 5, accepted_user_id = ?';
    expect(await upd('developer_invitations', both, id, [seed.admin.id])).toMatch(/CHECK/);
    expect(await upd('developer_invitations', 'accepted_at = 5', id)).toMatch(/CHECK/);
  });

  it('keeps identity columns and sets each end once', async () => {
    const { id } = await invitation();
    const set = (s: string, p: SqlValue[] = []) => upd('developer_invitations', s, id, p);
    for (const [col, value] of [
      ['email', 'x@example.test'],
      ['token_hash', 'h'],
      ['created_at', 1],
      ['expires_at', 3000],
      ['created_by_user', seed.admin.id],
    ] as const)
      expect(await set(`${col} = ?`, [value]), col).toMatch(/immutable developer invitation/);
    expect(await set('claim_until = 2500')).toBeNull();
    expect(await set('claim_until = 2400')).toMatch(/immutable/);
    expect(await set('revoked_at = 10')).toBeNull();
    expect(await set('revoked_at = 11')).toMatch(/immutable/);
    expect(await set('revoked_at = NULL')).toMatch(/immutable/);
    expect(await set('swept_at = 12')).toBeNull();
    expect(await set('swept_at = 13')).toMatch(/immutable/);
    expect(await refused('DELETE FROM developer_invitations WHERE id = ?', [id])).toMatch(
      /immutable/,
    );
  });

  it('sets accepted_at and its user together, once', async () => {
    const { id } = await invitation();
    const set = (s: string, p: SqlValue[] = []) => upd('developer_invitations', s, id, p);
    expect(await set('accepted_at = 20, accepted_user_id = ?', [seed.admin.id])).toBeNull();
    expect(await set('accepted_user_id = ?', [seed.user.id])).toMatch(/immutable/);
    expect(await set('accepted_at = 21')).toMatch(/immutable/);
    expect(await set('revoked_at = 22')).toMatch(/CHECK/);
  });

  it('refuses REPLACE through any unique key', async () => {
    const first = await invitation({
      org_invitation_id: seed.invitationId,
      token_hash: 'dup-hash',
    });
    expect(first.error).toBeNull();
    const replace = (over: Record<string, SqlValue>) =>
      insert(
        'developer_invitations',
        {
          id: next('di'),
          org_id: seed.org.id,
          email: 'a@example.test',
          token_hash: next('hash'),
          created_by_user: seed.user.id,
          created_at: 1,
          expires_at: 2,
          claim_until: 2,
          ...over,
        },
        'INSERT OR REPLACE',
      );
    expect(await replace({ id: first.id })).toMatch(/developer_invitations.id/);
    expect(await replace({ token_hash: 'dup-hash' })).toMatch(/developer_invitations.token_hash/);
    expect(await replace({ org_invitation_id: seed.invitationId })).toMatch(
      /developer_invitations.org_invitation_id/,
    );
    expect((await invitation({ token_hash: 'dup-hash' })).error).toMatch(/UNIQUE/);
  });
});

describe('developer_invite_setups', () => {
  const setup = (token: string, invitationId: string, verb = 'INSERT') =>
    insert(
      'developer_invite_setups',
      { idp_token_id: token, invitation_id: invitationId, created_at: 1, expires_at: 2 },
      verb,
    );

  it('holds at most three per invitation', async () => {
    const { id } = await invitation();
    for (let i = 0; i < 3; i++) expect(await setup(next('t'), id)).toBeNull();
    expect(await setup(next('t'), id)).toMatch(/developer setup cap/);
    expect(await setup(next('t'), (await invitation()).id)).toBeNull();
  });

  it('never changes, deletes or gets replaced', async () => {
    const { id } = await invitation();
    const token = next('t');
    expect(await setup(token, id)).toBeNull();
    const set = 'UPDATE developer_invite_setups SET expires_at = 9 WHERE idp_token_id = ?';
    expect(await refused(set, [token])).toMatch(/immutable developer setup/);
    expect(
      await refused('DELETE FROM developer_invite_setups WHERE idp_token_id = ?', [token]),
    ).toMatch(/immutable developer setup/);
    expect(await setup(token, (await invitation()).id, 'INSERT OR REPLACE')).toMatch(/UNIQUE/);
    const rows = await all(env.DB, 'SELECT 1 FROM developer_invite_setups WHERE idp_token_id = ?', [
      token,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('developer_sponsors', () => {
  it('allows one live sponsorship per person and org', async () => {
    const a = await sponsor();
    expect(a.error).toBeNull();
    const userId = a.row.user_id as string;
    expect((await sponsor({ user_id: userId })).error).toMatch(
      /UNIQUE constraint failed: developer_sponsors.org_id/,
    );
    const viaReplace = await insert(
      'developer_sponsors',
      { ...a.row, id: next('ds'), invitation_id: (await invitation()).id },
      'INSERT OR REPLACE',
    );
    expect(viaReplace).toMatch(/UNIQUE constraint failed: developer_sponsors.org_id/);
    // One sponsorship per invitation, ended or not.
    const sameInvitation = await sponsor({
      user_id: await freshUser(),
      invitation_id: a.row.invitation_id as string,
    });
    expect(sameInvitation.error).toMatch(/developer_sponsors.invitation_id/);
    // Ended, the person can be sponsored again.
    expect(
      await upd('developer_sponsors', "ended_at = 4000, end_reason = 'removed'", a.id),
    ).toBeNull();
    expect((await sponsor({ user_id: userId })).error).toBeNull();
  });

  it('keeps identity columns, ends once and settles once after the end', async () => {
    const { id } = await sponsor();
    const set = (s: string, p: SqlValue[] = []) => upd('developer_sponsors', s, id, p);
    for (const [col, value] of [
      ['idp_subject', 'other'],
      ['group_source', 'added'],
      ['created_at', 1],
      ['user_id', seed.admin.id],
    ] as const)
      expect(await set(`${col} = ?`, [value]), col).toMatch(/immutable developer sponsor/);
    expect(await set('settled_at = 5000')).toMatch(/CHECK/);
    expect(await set('ended_at = 4000')).toMatch(/CHECK/);
    expect(await set("ended_at = 4000, end_reason = 'org_closed'")).toBeNull();
    expect(await set("end_reason = 'removed'")).toMatch(/immutable/);
    expect(await set('ended_at = 4001')).toMatch(/immutable/);
    expect(await set('settled_at = 3999')).toMatch(/CHECK/);
    expect(await set('settled_at = 5000')).toBeNull();
    expect(await set('settled_at = 5001')).toMatch(/immutable/);
    expect(await set('settled_at = NULL')).toMatch(/immutable/);
    expect(await refused('DELETE FROM developer_sponsors WHERE id = ?', [id])).toMatch(/immutable/);
  });

  it('refuses an unknown source or end reason', async () => {
    expect((await sponsor({ group_source: 'invited' })).error).toMatch(/CHECK/);
    const { id } = await sponsor();
    expect(await upd('developer_sponsors', "ended_at = 1, end_reason = 'gone'", id)).toMatch(
      /CHECK/,
    );
  });
});

describe('org purge', () => {
  it('lets only a purging org delete its history, as the 0136 gates do', async () => {
    const names = [
      'developer_invitations_no_delete',
      'developer_invite_setups_no_delete',
      'developer_sponsors_no_delete',
    ];
    const rows = await all<{ name: string; sql: string }>(
      env.DB,
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map((n) => `'${n}'`).join(',')})`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...names].sort());
    for (const r of rows) expect(r.sql, r.name).toContain('o.purge_started_at IS NOT NULL');
  });
});
