import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fixtures,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

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
});
