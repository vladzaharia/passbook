import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';
import { branchIds } from './repo-user-passes.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function admin() {
  const user = await makeUser(f());
  const s = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return { user, headers: s.headers };
}

interface Item {
  id: string;
  orgId: string;
  orgStatus: string;
  orgName: string;
  holding: string;
  channels: string[];
  timeZone: string;
  [key: string]: unknown;
}
const read = async (id: string, headers: Record<string, string>, query = '') =>
  (await (await h.call(`/api/v1/users/${id}/passes${query}`, { headers })).json()) as {
    items: Item[];
    nextCursor: string | null;
  };

describe('GET /api/v1/users/{id}/passes', () => {
  it('lists the passes across organizations, newest first, matched by owner and verified address', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const other = await makeUser(f());
    const tpl = makeTemplate().resolved;
    const orgA = await makeOrg(f(), { name: 'North' });
    const orgB = await makeOrg(f(), { name: 'South' });
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', 0)",
      ['second@example.com', person.id],
    );
    await run(
      h.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', '\"Europe/Paris\"', 0)",
      [`org:${orgB.id}`],
    );
    const owned = await makePass(f(), { orgId: orgA.id, template: tpl, ownerUserId: person.id });
    const waiting = await makePass(f(), {
      orgId: orgB.id,
      template: tpl,
      holderEmail: 'second@example.com',
    });
    await makePass(f(), { orgId: orgA.id, template: tpl, ownerUserId: other.id });
    await makePass(f(), { orgId: orgA.id, template: tpl, holderEmail: 'nobody@example.com' });
    // Owned by someone else: the address does not pull it in.
    await makePass(f(), {
      orgId: orgA.id,
      template: tpl,
      ownerUserId: other.id,
      holderEmail: 'second@example.com',
    });

    const body = await read(person.id, a.headers);
    // UUIDv7 order, newest first.
    const [newer, older] = [waiting, owned].sort((x, y) => (x.id < y.id ? 1 : -1)) as [
      typeof waiting,
      typeof owned,
    ];
    expect(body.items.map((p) => p.id)).toEqual([newer.id, older.id]);
    const zone = (id: string) => body.items.find((p) => p.id === id)?.timeZone;
    expect(zone(waiting.id)).toBe('Europe/Paris');
    expect(zone(owned.id)).toBe('America/Los_Angeles');
    expect(body.nextCursor).toBeNull();

    const first1 = await read(person.id, a.headers, '?limit=1');
    expect(first1.items.map((p) => p.id)).toEqual([newer.id]);
    const next = await read(person.id, a.headers, `?limit=1&cursor=${first1.nextCursor}`);
    expect(next.items.map((p) => p.id)).toEqual([older.id]);
  });

  it('leaves out a deleted organization, marks a suspended one', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const tpl = makeTemplate().resolved;
    const gone = await makeOrg(f());
    const paused = await makeOrg(f());
    await makePass(f(), { orgId: gone.id, template: tpl, ownerUserId: person.id });
    const kept = await makePass(f(), { orgId: paused.id, template: tpl, ownerUserId: person.id });
    await run(h.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [gone.id]);
    await run(h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [paused.id]);
    const body = await read(person.id, a.headers);
    expect(body.items.map((p) => [p.id, p.orgStatus])).toEqual([[kept.id, 'suspended']]);
  });

  it('never carries personalization, titles or capability URLs', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const org = await makeOrg(f());
    await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      ownerUserId: person.id,
      personalization: { name: 'Zed Secretson' },
    });
    await run(h.env.DB, "UPDATE passes SET display_title = 'Zed Secretson' WHERE org_id = ?", [
      org.id,
    ]);
    const res = await h.call(`/api/v1/users/${person.id}/passes`, { headers: a.headers });
    const text = await res.text();
    expect(text).not.toContain('Zed');
    expect(text).not.toMatch(/token|url|title|personalization/i);
    // The user page lists passes too, and carries no holder title either.
    const detail = await (
      await h.call(`/api/v1/users/${person.id}`, { headers: a.headers })
    ).text();
    expect(detail).not.toContain('Zed');
    expect(detail).not.toContain('"title"');
  });

  it('writes a platform audit row with the count and no email', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const org = await makeOrg(f());
    await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      ownerUserId: person.id,
    });
    await read(person.id, a.headers);
    const row = await first<{ actor_id: string; org_id: string | null; detail: string }>(
      h.env.DB,
      "SELECT actor_id, org_id, detail FROM audit_log WHERE action = 'platform.user_passes_read' AND target_id = ?",
      [person.id],
    );
    expect(row?.actor_id).toBe(a.user.id);
    expect(row?.org_id).toBeNull();
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ count: 1 });
    expect(row?.detail).not.toContain('@');
  });

  it('refuses a user who is not a platform admin, and answers 404 for no such user', async () => {
    const plain = await makeUser(f());
    const s = await makeSession(f(), { userId: plain.id, roles: ['user'] });
    await expectProblem(
      await h.call(`/api/v1/users/${plain.id}/passes`, { headers: s.headers }),
      403,
      'FORBIDDEN',
    );
    const a = await admin();
    const res = await h.call(`/api/v1/users/${crypto.randomUUID()}/passes`, { headers: a.headers });
    expect(res.status).toBe(404);
  });

  it("leaves out another person's personal organization, and shows the viewer's own as Personal", async () => {
    const a = await admin();
    const person = await makeUser(f());
    const tpl = makeTemplate().resolved;
    const theirs = await makeOrg(f(), { name: 'B Personal Org', personalUserId: person.id });
    const mine = await makeOrg(f(), { name: 'A Personal Org', personalUserId: a.user.id });
    await makePass(f(), { orgId: theirs.id, template: tpl, ownerUserId: person.id });
    const own = await makePass(f(), { orgId: mine.id, template: tpl, ownerUserId: person.id });
    const body = await read(person.id, a.headers);
    expect(body.items.map((p) => [p.id, p.orgName])).toEqual([[own.id, 'Personal']]);
    const detail = (await (
      await h.call(`/api/v1/users/${person.id}`, { headers: a.headers })
    ).json()) as { passes: { id: string }[] };
    expect(detail.passes.map((p) => p.id)).toEqual([own.id]);
  });

  it('does not match an unproven primary email', async () => {
    const a = await admin();
    const claimant = await makeUser(f());
    const org = await makeOrg(f());
    await run(h.env.DB, 'DELETE FROM user_emails WHERE user_id = ?', [claimant.id]);
    await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      holderEmail: claimant.primaryEmail,
    });
    expect((await read(claimant.id, a.headers)).items).toEqual([]);
  });

  it('marks waiting against owned, leaves out join-link and quarantined passes', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const org = await makeOrg(f());
    const tpl = makeTemplate().resolved;
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('w@example.com', ?, 'admin', 0)",
      [person.id],
    );
    const owned = await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id });
    const waiting = await makePass(f(), {
      orgId: org.id,
      template: tpl,
      holderEmail: 'w@example.com',
    });
    const joined = await makePass(f(), {
      orgId: org.id,
      template: tpl,
      holderEmail: 'w@example.com',
    });
    const quarantined = await makePass(f(), {
      orgId: org.id,
      template: tpl,
      ownerUserId: person.id,
    });
    await run(
      h.env.DB,
      "INSERT INTO join_marks (pass_id, org_id, mode, created_at) VALUES (?, ?, 'live', 0)",
      [joined.id, org.id],
    );
    await run(h.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantined.id,
    ]);
    const body = await read(person.id, a.headers);
    const holding = Object.fromEntries(body.items.map((p) => [p.id, p.holding]));
    expect(holding).toEqual({ [owned.id]: 'owned', [waiting.id]: 'waiting' });
  });

  it('does not count a ready wallet instance as a copy', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const org = await makeOrg(f());
    const pass = await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      ownerUserId: person.id,
    });
    const now = h.clock.now();
    // Issuance guards are not under test: only how the list reads a row.
    const guards = await h.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_provider_instances'",
    ).all<{ name: string }>();
    for (const g of guards.results)
      await h.env.DB.prepare(`DROP TRIGGER IF EXISTS ${g.name}`).run();
    const instance = (provider: string, lifecycle: string) =>
      run(
        h.env.DB,
        `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation,
           lifecycle, desired_version, created_at, updated_at)
         VALUES (?, ?, ?, 'live', ?, 1, ?, 0, ?, ?)`,
        [crypto.randomUUID(), pass.id, org.id, provider, lifecycle, now, now],
      );
    // A ready instance has saved nothing yet.
    await instance('google', 'ready');
    const body = await read(person.id, a.headers);
    expect(body.items[0]?.channels).toEqual([]);
  });

  it('pages exactly across the owner and address branches, within the indexes', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const org = await makeOrg(f());
    const tpl = makeTemplate().resolved;
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('p@example.com', ?, 'admin', 0)",
      [person.id],
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id })).id);
      ids.push(
        (await makePass(f(), { orgId: org.id, template: tpl, holderEmail: 'p@example.com' })).id,
      );
    }
    const expected = [...ids].sort().reverse();
    const seen: string[] = [];
    let cursor = '';
    for (let n = 0; n < 4; n++) {
      const page = await read(person.id, a.headers, `?limit=2${cursor}`);
      seen.push(...page.items.map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = `&cursor=${page.nextCursor}`;
    }
    expect(seen).toEqual(expected);
    for (const [kind, index] of [
      ['p.owner_user_id = ?1', 'passes_owner_live'],
      ['p.owner_user_id IS NULL AND p.holder_email = ?1', 'passes_waiting_live'],
    ] as const) {
      const plan = await h.env.DB.prepare(
        `EXPLAIN QUERY PLAN SELECT p.id FROM passes p JOIN orgs o ON o.id = p.org_id
         WHERE ${kind} AND p.id < ?2 AND p.deleted_at IS NULL AND p.mode = 'live'
         ORDER BY p.id DESC LIMIT ?3`,
      )
        .bind('x', '~', 3)
        .all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).join('\n')).toContain(index);
    }
  });

  it('refuses a console-role session', async () => {
    const person = await makeUser(f());
    const s = await makeSession(f(), { userId: person.id, roles: ['user', 'console'] });
    await expectProblem(
      await h.call(`/api/v1/users/${person.id}/passes`, { headers: s.headers }),
      403,
      'FORBIDDEN',
    );
  });

  it('refuses an email-link session even with the admin role', async () => {
    const person = await makeUser(f());
    const s = await makeSession(f(), {
      userId: person.id,
      roles: ['admin', 'user'],
      amr: 'magic_link',
    });
    // Inside the grace window requireAdmin lets it through; the strict guard is what refuses.
    await run(h.env.DB, 'INSERT INTO console_email_grace (user_id, created_at) VALUES (?, 1)', [
      person.id,
    ]);
    await run(
      h.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.consoleEmailUntil', ?, 1)",
      [String(h.clock.now() + 86_400_000)],
    );
    const res = await h.call(`/api/v1/users/${person.id}/passes`, { headers: s.headers });
    expect([401, 403]).toContain(res.status);
  });

  it('refuses an API key and a bad cursor', async () => {
    const a = await admin();
    const key = await makeApiKey(f());
    expect(
      (await h.call(`/api/v1/users/${a.user.id}/passes`, { headers: key.headers })).status,
    ).toBe(401);
    const res = await h.call(`/api/v1/users/${a.user.id}/passes?cursor=${'x'.repeat(100)}`, {
      headers: a.headers,
    });
    expect(res.status).toBe(422);
  });

  it('leaves out deleted, test and closed-org passes from the user page, and its counts match', async () => {
    const a = await admin();
    const person = await makeUser(f());
    const tpl = makeTemplate().resolved;
    const org = await makeOrg(f());
    const closed = await makeOrg(f());
    const personal = await makeOrg(f(), { personalUserId: (await makeUser(f())).id });
    const live = await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id });
    const gone = await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id });
    await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id, mode: 'test' });
    await makePass(f(), { orgId: closed.id, template: tpl, ownerUserId: person.id });
    await makePass(f(), { orgId: personal.id, template: tpl, ownerUserId: person.id });
    await run(h.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [gone.id]);
    await run(h.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [closed.id]);
    const detail = (await (
      await h.call(`/api/v1/users/${person.id}`, { headers: a.headers })
    ).json()) as { passes: { id: string }[]; passCount: number };
    expect(detail.passes.map((p) => p.id)).toEqual([live.id]);
    expect(detail.passCount).toBe(1);
    const list = (await (
      await h.call('/api/v1/users?limit=200', { headers: a.headers })
    ).json()) as {
      items: { id: string; passCount: number }[];
    };
    expect(list.items.find((u) => u.id === person.id)?.passCount).toBe(1);
  });

  it('stops the walk at its cap and resumes from a cursor', async () => {
    const person = await makeUser(f());
    const tpl = makeTemplate().resolved;
    const org = await makeOrg(f());
    const closed = await makeOrg(f());
    const live = await makePass(f(), { orgId: org.id, template: tpl, ownerUserId: person.id });
    const hidden: string[] = [];
    for (let i = 0; i < 4; i++)
      hidden.push(
        (await makePass(f(), { orgId: closed.id, template: tpl, ownerUserId: person.id })).id,
      );
    await run(h.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [closed.id]);
    // Ids are not in creation order here: walk in id order.
    const order = [live.id, ...hidden].sort().reverse();
    const liveAt = order.indexOf(live.id);
    const cap = Math.max(liveAt, 1);
    const first = await branchIds(h.env.DB, 'owner', person.id, '~', 2, 'viewer', cap);
    if (liveAt === 0) {
      expect(first.ids).toEqual([live.id]);
      return;
    }
    expect(first.ids).toEqual([]);
    expect(first.scannedTo).toBe(order[cap - 1]);
    let cursor = first.scannedTo ?? '';
    const found: string[] = [];
    for (let n = 0; n < 5 && cursor; n++) {
      const next = await branchIds(h.env.DB, 'owner', person.id, cursor, 2, 'viewer', cap);
      found.push(...next.ids);
      cursor = next.scannedTo ?? '';
    }
    expect(found).toEqual([live.id]);
  });
});
