import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import type { MailMessage } from '../delivery/mailer.ts';
import { overrideDeps } from '../passes/deps.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { ACCESS, accessTemplate, grantOf, makeDoor } from '../scan/access-test-fixtures.ts';
import { CHECK_IN, HOUR, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { station, useKit } from '../scan/occupancy/whos-in-test-fixtures.ts';
import { grantScanMembership, key } from '../scan/test-kit.ts';
import { offboard } from './offboard.ts';
import { cancelVisit, checkOutVisit, createVisit, listVisits } from './service.ts';

let tpl: string;
const sent: MailMessage[] = [];
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await accessTemplate(ACCESS);
  overrideDeps(kit.env, {
    mailer: {
      async send(m) {
        sent.push(m);
        return { messageId: 'm1' };
      },
    },
  });
});

const day = () => {
  const start = kit.clock.now() - 2 * HOUR;
  return { start, end: start + 24 * HOUR };
};

async function authorityIn(orgId: string, userId: string) {
  const session = await makeSession(kit.fx, { userId, roles: ['user'] });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('session');
  return tenantAuthorityOf(kit.ctx, { ...resolved, mode: 'live' }, orgId, 'passes:operate');
}
const admin = () => authorityIn(kit.org.id, 'admin-1');

async function outsider(withTemplate = true) {
  const org = await makeOrg(kit.fx);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, org.id, user.id, ['org_admin']);
  const template = withTemplate
    ? await kit.scanTemplate('Guest', { actions: [CHECK_IN], access: ACCESS }, { orgId: org.id })
    : '';
  return { org, template, authority: await authorityIn(org.id, user.id) };
}

/** A visit row around a pass made by the scan kit, as the invite would leave it. */
async function visit(over: { from?: number; until?: number; orgId?: string; email?: string } = {}) {
  const pass = await kit.scanPass(
    tpl,
    { plan: 'guest', memberName: 'Leo Park' },
    {
      ...(over.orgId ? { orgId: over.orgId } : {}),
      ...(over.email ? { holderEmail: over.email } : {}),
    },
  );
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, note, created_at)
     VALUES (?, ?, 'live', ?, 'Leo Park', 'Ana Ruiz', 'ana@host.test', ?, ?, 'Gate code 4411', ?)`,
    [
      id,
      over.orgId ?? kit.org.id,
      pass.id,
      over.from ?? now - HOUR,
      over.until ?? now + 8 * HOUR,
      now,
    ],
  );
  return { id, pass };
}

const statusOf = async (id: string, tab: 'today' | 'upcoming' | 'past' = 'today') => {
  const found = (await listVisits(kit.ctx, kit.org.id, 'live', tab, day())).find(
    (v) => v.id === id,
  );
  return found;
};
const signOut = (headers: Record<string, string>, passId: string) =>
  kit.post(headers, '/sign-out', { idempotencyKey: key(), passId, tag: 'none' });

describe('visitor status, from scans and the window', () => {
  it('goes expected, in, out through the door and the desk, and lists by tab', async () => {
    const door = await makeDoor([tpl]);
    const desk = await station([tpl], []);
    const v = await visit();
    expect((await statusOf(v.id))?.status).toBe('expected');
    expect((await signOut(desk.headers, v.pass.id)).status).toBe(409);

    expect(await grantOf(door.headers, v.pass)).toMatchObject({ kind: 'ok' });
    expect(await statusOf(v.id)).toMatchObject({ status: 'in', hostName: 'Ana Ruiz' });

    kit.clock.advance(HOUR);
    const res = await signOut(desk.headers, v.pass.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: v.pass.id, stayMs: HOUR, tag: 'none' });
    expect(await statusOf(v.id)).toMatchObject({ status: 'out' });
    // A retry is not an error for a visitor.
    expect((await signOut(desk.headers, v.pass.id)).status).toBe(200);
    expect(await statusOf(v.id, 'past')).toBeUndefined();
  });

  it('shows a no-show in Past and an upcoming visit in Upcoming', async () => {
    const now = kit.clock.now();
    const missed = await visit({ from: now - 30 * HOUR, until: now - 20 * HOUR });
    const later = await visit({ from: now + 30 * HOUR, until: now + 38 * HOUR });
    expect(await statusOf(missed.id, 'past')).toMatchObject({ status: 'no_show' });
    expect(await statusOf(later.id, 'upcoming')).toMatchObject({ status: 'expected' });
    expect(await statusOf(later.id)).toBeUndefined();
  });

  it('reads as out at the window end for someone still in (auto check-out)', async () => {
    const door = await makeDoor([tpl]);
    const now = kit.clock.now();
    const v = await visit({ from: now - HOUR, until: now + 2 * HOUR });
    await grantOf(door.headers, v.pass);
    kit.clock.advance(3 * HOUR);
    expect(await statusOf(v.id)).toMatchObject({
      status: 'out',
      autoOut: true,
      statusAt: now + 2 * HOUR,
    });
  });

  it('records a console check-out for someone who came in at an untracked door', async () => {
    const door = await makeDoor([tpl]);
    const v = await visit();
    const a = await admin();
    await expect(checkOutVisit(kit.ctx, a, v.id)).rejects.toMatchObject({ code: 'VISITOR_NOT_IN' });
    await grantOf(door.headers, v.pass);
    expect(await checkOutVisit(kit.ctx, a, v.id)).toMatchObject({ status: 'out' });
    await expect(checkOutVisit(kit.ctx, a, v.id)).rejects.toMatchObject({ code: 'VISITOR_OUT' });
    const audit = await all(kit.env.DB, "SELECT 1 FROM audit_log WHERE action = 'visitor.out'");
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('host email on arrival', () => {
  it('mails the host once, with the visitor name and no other personal detail', async () => {
    sent.length = 0;
    const door = await makeDoor([tpl]);
    const v = await visit({ email: 'leo.guest@example.test' });
    await grantOf(door.headers, v.pass);
    await vi.waitFor(() => expect(sent.filter((m) => m.to === 'ana@host.test')).toHaveLength(1));
    const mail = sent.find((m) => m.to === 'ana@host.test') as MailMessage;
    expect(mail.subject).toBe('Leo Park is here');
    for (const body of [mail.html, mail.text, mail.subject]) {
      expect(body).not.toContain('leo.guest@example.test');
      expect(body).not.toContain('Gate code 4411');
      expect(body).not.toContain('ana@host.test');
    }
    // Later in the day: the visit is already announced.
    kit.clock.advance(3 * HOUR);
    await grantOf(door.headers, v.pass);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => m.to === 'ana@host.test')).toHaveLength(1);
  });

  it('mails nobody for a pass that is not a visitor', async () => {
    sent.length = 0;
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest' });
    await grantOf(door.headers, pass);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => m.to === 'ana@host.test')).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('lists and changes only the caller org', async () => {
    const v = await visit();
    const other = await outsider();
    expect(await listVisits(kit.ctx, other.org.id, 'live', 'today', day())).toEqual([]);
    await expect(checkOutVisit(kit.ctx, other.authority, v.id)).rejects.toMatchObject({
      code: 'VISITOR_NOT_FOUND',
    });
    await expect(
      cancelVisit(kit.ctx, { type: 'user', id: 'x' }, other.authority, v.id),
    ).rejects.toMatchObject({ code: 'VISITOR_NOT_FOUND' });
    expect(await statusOf(v.id)).toMatchObject({ status: 'expected' });
  });

  it('refuses another org even with a member session', async () => {
    const other = await outsider();
    await expect(authorityIn(kit.org.id, (await makeUser(kit.fx)).id)).rejects.toBeTruthy();
    await expect(tenantAuthorityIn(other.org.id)).resolves.toBeTruthy();
  });

  it("will not sign out another org's pass at a desk", async () => {
    const other = await outsider();
    const foreign = await kit.scanPass(other.template, { plan: 'guest' }, { orgId: other.org.id });
    const desk = await station([tpl], []);
    const res = await signOut(desk.headers, foreign.id);
    expect(res.status).toBe(404);
  });
});

async function tenantAuthorityIn(orgId: string) {
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, orgId, user.id, ['org_admin']);
  return authorityIn(orgId, user.id);
}

describe('invite and cancel', () => {
  it('issues a pass with a host, then voids it on cancel', async () => {
    const a = await admin();
    const created = await createVisit(kit.ctx, { type: 'user', id: 'admin-1' }, a, {
      orgId: kit.org.id,
      name: 'Mia Stone',
      email: 'mia@example.test',
      hostName: 'Ana Ruiz',
      hostEmail: 'ana@host.test',
      windowFrom: kit.clock.now(),
      windowUntil: kit.clock.now() + 8 * HOUR,
      note: 'Floor 4',
    });
    expect(created).toMatchObject({ name: 'Mia Stone', hostName: 'Ana Ruiz', status: 'expected' });
    const pass = await first<{ status: string; holder_email: string }>(
      kit.env.DB,
      'SELECT status, holder_email FROM passes WHERE id = ?',
      [created.passId],
    );
    expect(pass).toEqual({ status: 'active', holder_email: 'mia@example.test' });
    const cancelled = await cancelVisit(kit.ctx, { type: 'user', id: 'admin-1' }, a, created.id);
    expect(cancelled.status).toBe('cancelled');
    expect(
      (
        await first<{ status: string }>(kit.env.DB, 'SELECT status FROM passes WHERE id = ?', [
          created.passId,
        ])
      )?.status,
    ).toBe('voided');
  });

  it('asks for a guest template first, and refuses a bad window', async () => {
    const other = await outsider(false);
    const body = {
      orgId: other.org.id,
      name: 'Mia',
      hostName: 'Ana',
      hostEmail: 'ana@host.test',
      windowFrom: kit.clock.now(),
      windowUntil: kit.clock.now() + HOUR,
    };
    await expect(
      createVisit(kit.ctx, { type: 'user', id: 'x' }, other.authority, body),
    ).rejects.toMatchObject({ code: 'VISITOR_TEMPLATE_MISSING' });
    await expect(
      createVisit(kit.ctx, { type: 'user', id: 'x' }, other.authority, {
        ...body,
        windowUntil: body.windowFrom,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('offboard', () => {
  it('counts on a dry run, then voids the passes of one email in this org only', async () => {
    const a = await admin();
    const other = await outsider();
    const mine = await kit.scanPass(tpl, { plan: 'guest' }, { holderEmail: 'leaver@example.test' });
    const theirs = await kit.scanPass(
      other.template,
      { plan: 'guest' },
      { orgId: other.org.id, holderEmail: 'leaver@example.test' },
    );
    const req = {
      holderEmail: 'Leaver@Example.test',
      passes: 'void',
      tags: 'spare',
      dryRun: true,
    } as const;
    const actor = { type: 'user', id: 'admin-1' } as const;
    expect(await offboard(kit.ctx, actor, a, req)).toEqual({
      dryRun: true,
      holders: 1,
      passes: 1,
      tags: 0,
    });
    expect(await offboard(kit.ctx, actor, a, { ...req, dryRun: false })).toMatchObject({
      passes: 1,
    });
    const state = (id: string) =>
      first<{ status: string }>(kit.env.DB, 'SELECT status FROM passes WHERE id = ?', [id]);
    expect(await state(mine.id)).toEqual({ status: 'voided' });
    expect(await state(theirs.id)).toEqual({ status: 'active' });
  });

  it('ends the tags of the passes, or reports them lost when they are not handed back', async () => {
    const a = await admin();
    const actor = { type: 'user', id: 'admin-1' } as const;
    const tagged = async (email: string) => {
      const pass = await kit.scanPass(tpl, { plan: 'guest' }, { holderEmail: email });
      const tagId = kit.fx.ids.id();
      const ref = kit.fx.ids.id().replace(/-/g, '').padEnd(64, 'a').slice(0, 64);
      await run(
        kit.env.DB,
        `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, kind, hint, created_at)
         VALUES (?, ?, 'live', ?, 'uid', ?, 1)`,
        [tagId, kit.org.id, ref, ref.slice(0, 4).toUpperCase()],
      );
      await run(
        kit.env.DB,
        `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
         SELECT ?, ?, 'pass', id, 'admin', 1, 'user', 'admin-1', credential_generation FROM passes WHERE id = ?`,
        [kit.fx.ids.id(), tagId, pass.id],
      );
      return tagId;
    };
    const base = { passes: 'void', dryRun: false } as const;
    const spare = await tagged('spare@example.test');
    const lost = await tagged('lost@example.test');
    expect(
      await offboard(kit.ctx, actor, a, {
        ...base,
        holderEmail: 'spare@example.test',
        tags: 'spare',
      }),
    ).toMatchObject({ tags: 1 });
    await offboard(kit.ctx, actor, a, { ...base, holderEmail: 'lost@example.test', tags: 'lost' });
    const state = (id: string) =>
      first<{ lost_at: number | null; ended: number }>(
        kit.env.DB,
        `SELECT t.lost_at, (SELECT count(*) FROM tag_bindings b WHERE b.tag_id = t.id AND b.ended_at IS NOT NULL
           AND b.end_cause = 'offboard') AS ended FROM nfc_tags t WHERE t.id = ?`,
        [id],
      );
    expect(await state(spare)).toEqual({ lost_at: null, ended: 1 });
    expect(await state(lost)).toMatchObject({ ended: 1 });
    expect((await state(lost))?.lost_at).not.toBeNull();
  });
});
