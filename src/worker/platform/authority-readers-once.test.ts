// The readers on the join-once form (operations fences, org members and invitations for a key, the NFC
// pass-in-limits read) return what a plain statement bound to the actor's own org and mode returns, for every actor.
import { describe, expect, it } from 'vitest';
import { passInTenantLimits } from '../modules/nfc/repo-tag-bindings.ts';
import {
  orgFence,
  platformFence,
  platformKeyFence,
  starterFence,
} from '../modules/operations/repo-fence.ts';
import { getFenced, listFenced } from '../modules/operations/repo-read.ts';
import { keyOrgInvitations, keyOrgMembers } from '../modules/orgs/repo-members.ts';
import { passRow } from './authority-checks.ts';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
import { type Actor, actors, seed } from './authority-read-join-fixtures.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { all, first, run } from './db.ts';

const SELECT_MEMBERS = `m.*, o.name AS org_name, o.slug AS org_slug, o.personal_user_id, o.kind AS org_kind, u.name AS user_name,
       COALESCE((SELECT i.email FROM org_invitations i WHERE i.id = m.invitation_id), 'Account') AS user_email`;

async function world() {
  const s = await seed();
  const now = s.f.clock.now();
  const list = await actors(s);
  const checksOf = (a: Actor) =>
    a.check ? passRow(a.check === 'own' ? s.w.a.pass : (s.tb.passes.live ?? '')) : [];
  for (const o of [s.a, s.b])
    await run(
      db,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, '["read_only"]', ?, 1, 2)`,
      [`inv-${o.id}`, o.id, `${o.id}@example.test`, `th-${o.id}`],
    );
  const op = async (
    id: string,
    audience: string,
    orgId: string | null,
    mode: string | null,
    actorType: string,
    actorId: string | null,
  ) =>
    run(
      db,
      `INSERT INTO operations (id, kind, audience, org_id, mode, steps, actor_type, actor_id, created_at, updated_at)
       VALUES (?, 'k', ?, ?, ?, '[]', ?, ?, 1, 1)`,
      [id, audience, orgId, mode, actorType, actorId],
    );
  await op(`${s.ident('op')}-al`, 'org', s.a.id, 'live', 'user', 'u');
  await op(`${s.ident('op')}-at`, 'org', s.a.id, 'test', 'user', 'u');
  await op(`${s.ident('op')}-bl`, 'org', s.b.id, 'live', 'user', 'u');
  await op(`${s.ident('op')}-pl`, 'platform', null, null, 'user', 'u');
  const keyIds = new Set(
    list.flatMap((a) => (a.principal.kind === 'api_key' ? [a.principal.keyId] : [])),
  );
  for (const k of keyIds) {
    await op(`${s.ident('op')}-pk-${k}`, 'platform', null, null, 'api_key', k);
    await op(`${s.ident('op')}-sk-${k}`, 'starter', null, null, 'api_key', k);
  }
  return { s, now, list, checksOf };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

interface ActorRow {
  org_id: string | null;
  mode: string | null;
  limit_key: string | null;
}

/** The actor row the predicate resolves (none when the actor fails its checks). */
async function actorRow(p: ReturnType<typeof authorityPredicate>): Promise<ActorRow | null> {
  return first<ActorRow>(
    db,
    `WITH ${p.ctes} SELECT org_id, mode, limit_key FROM actor_ok`,
    p.params,
  );
}

describe('operations fences', () => {
  it('read the rows a plain statement bound to the actor reads', async () => {
    const { now, list, checksOf } = await world();
    const filter = {
      active: false,
      actor: null,
      kinds: null,
      kind: null,
      target: null,
      after: null,
      limit: 100,
    };
    let nonEmpty = 0;
    for (const a of list) {
      const cases: { name: string; fence: ReturnType<typeof orgFence>; was: string[] }[] = [];
      const order = 'ORDER BY created_at DESC, id DESC';
      const p = authorityPredicate(a.principal, { scope: 'org_mode', now, checks: checksOf(a) });
      const r = await actorRow(p);
      if (a.scope === 'org_mode')
        cases.push({
          name: 'org',
          fence: orgFence(a.principal, checksOf(a), now),
          was:
            r && r.limit_key === null
              ? ids(
                  await all<{ id: string }>(
                    db,
                    `SELECT id FROM operations WHERE audience = 'org' AND org_id = ? AND mode = ? ${order}`,
                    [r.org_id, r.mode],
                  ),
                )
              : [],
        });
      if (a.principal.kind === 'platform') {
        const q = authorityPredicate(a.principal, { scope: 'platform', now });
        cases.push({
          name: 'platform',
          fence: platformFence(a.principal, now),
          was: (await actorRow(q))
            ? ids(
                await all<{ id: string }>(
                  db,
                  `SELECT id FROM operations WHERE audience = 'platform' ${order}`,
                  [],
                ),
              )
            : [],
        });
      }
      if (a.principal.kind === 'api_key') {
        const q = authorityPredicate(a.principal, { scope: 'platform', now });
        cases.push({
          name: 'platform key',
          fence: platformKeyFence(a.principal, now),
          was: (await actorRow(q))
            ? ids(
                await all<{ id: string }>(
                  db,
                  `SELECT id FROM operations WHERE audience IN ('platform', 'starter') AND org_id IS NULL AND actor_type = 'api_key' AND actor_id = ? ${order}`,
                  [a.principal.keyId],
                ),
              )
            : [],
        });
      }
      for (const c of cases) {
        const { was } = c;
        const sql = `WITH ${c.fence.ctes} SELECT o.id FROM ${c.fence.from} WHERE ${c.fence.where} ORDER BY o.created_at DESC, o.id DESC`;
        assertActorOnce(sql);
        const params = [...c.fence.ctesParams, ...c.fence.whereParams];
        expect(ids(await all<{ id: string }>(db, sql, params)), `${a.name}: ${c.name}`).toEqual(
          was,
        );
        expect(ids(await listFenced(db, c.fence, filter)), `${a.name}: ${c.name} list`).toEqual(
          was,
        );
        for (const id of was)
          expect((await getFenced(db, c.fence, id))?.id, `${a.name}: ${c.name} get`).toBe(id);
        if (was.length > 0) nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(8);
  });
});

describe('starter fence', () => {
  it('has no actor join and reads through listFenced', async () => {
    await world();
    const fence = starterFence({ userId: 'u', sessionId: 'none' }, 1);
    expect(fence.from).toBe('operations o');
    expect(fence.ctes).toBe('');
    expect(
      await listFenced(db, fence, {
        active: false,
        actor: null,
        kinds: null,
        kind: null,
        target: null,
        after: null,
        limit: 10,
      }),
    ).toEqual([]);
  });
});

describe('org members and invitations for a key', () => {
  it('return the rows of the own org of the actor', async () => {
    const { s, now, list, checksOf } = await world();
    let nonEmpty = 0;
    for (const a of list) {
      const checks = checksOf(a);
      const p = authorityPredicate(a.principal, { scope: 'org', now, checks });
      const r = await actorRow(p);
      for (const orgId of [s.a.id, s.b.id]) {
        const mine = r !== null && r.limit_key === null && r.org_id === orgId;
        const members = mine
          ? await all(
              db,
              `SELECT ${SELECT_MEMBERS}
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active'
     ORDER BY m.created_at, m.id`,
              [orgId],
            )
          : [];
        expect(
          await keyOrgMembers(db, orgId, a.principal, checks, now),
          `${a.name}: members`,
        ).toEqual(members);
        const invitations = mine
          ? await all(
              db,
              `SELECT m.id, m.org_id, m.email, m.roles, m.created_at, m.expires_at, m.revoked_at, m.accepted_at
     FROM org_invitations m WHERE m.org_id = ? ORDER BY m.created_at, m.id`,
              [orgId],
            )
          : [];
        expect(
          await keyOrgInvitations(db, orgId, a.principal, checks, now),
          `${a.name}: invitations`,
        ).toEqual(invitations);
        if (members.length > 0 && invitations.length > 0) nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(5);
  });
});

describe('pass in tenant limits', () => {
  it('answers for the own org and mode', async () => {
    const { s, now, list } = await world();
    const passes = [
      s.w.a.pass,
      s.w.b.pass,
      s.w.c.pass,
      s.tt.passes.test ?? '',
      s.tb.passes.live ?? '',
    ];
    let yes = 0;
    for (const a of list) {
      if (a.scope !== 'org_mode') continue;
      const r = await actorRow(authorityPredicate(a.principal, { scope: 'org_mode', now }));
      // A key limited to templates is covered by authority-restrict.test.ts.
      if (r?.limit_key) continue;
      for (const passId of passes) {
        const was = r
          ? await first(db, 'SELECT id FROM passes WHERE id = ? AND org_id = ? AND mode = ?', [
              passId,
              r.org_id,
              r.mode,
            ])
          : null;
        const got = await passInTenantLimits(db, a.principal, now, passId);
        expect(got, `${a.name}: ${passId}`).toBe(was !== null);
        if (got) yes++;
      }
    }
    expect(yes).toBeGreaterThan(10);
  });
});
