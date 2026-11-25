import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { ACCESS, accessTemplate } from '../scan/access-test-fixtures.ts';
import { CHECK_IN, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { offboard } from './offboard.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate(ACCESS);
});

const actor = { type: 'user', id: 'admin-1' } as const;

async function authorityIn(orgId: string, userId: string) {
  const session = await makeSession(kit.fx, { userId, roles: ['user'] });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('session');
  return tenantAuthorityOf(kit.ctx, { ...resolved, mode: 'live' }, orgId, 'passes:operate');
}
const admin = () => authorityIn(kit.org.id, 'admin-1');

async function outsider() {
  const org = await makeOrg(kit.fx);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, org.id, user.id, ['org_admin']);
  const template = await kit.scanTemplate(
    'Guest',
    { actions: [CHECK_IN], access: ACCESS },
    { orgId: org.id },
  );
  return { org, template, authority: await authorityIn(org.id, user.id) };
}

const statusOf = (id: string) =>
  first<{ status: string }>(kit.env.DB, 'SELECT status FROM passes WHERE id = ?', [id]);

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
    expect(await offboard(kit.ctx, actor, a, req)).toEqual({
      dryRun: true,
      holders: 1,
      passes: 1,
      tags: 0,
      more: false,
    });
    expect(await statusOf(mine.id)).toEqual({ status: 'active' });
    expect(await offboard(kit.ctx, actor, a, { ...req, dryRun: false })).toMatchObject({
      passes: 1,
    });
    expect(await statusOf(mine.id)).toEqual({ status: 'voided' });
    expect(await statusOf(theirs.id)).toEqual({ status: 'active' });
  });

  it('ends the tags of the passes, or reports them lost when they are not handed back', async () => {
    const a = await admin();
    const tagged = async (email: string) => {
      const pass = await kit.scanPass(tpl, { plan: 'guest' }, { holderEmail: email });
      const tagId = kit.fx.ids.id();
      const ref = kit.fx.ids.id().replace(/-/g, '').padEnd(64, 'a').slice(0, 64);
      await run(
        kit.env.DB,
        `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at)
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

  it('handles 100 passes a call and says more until all 150, each with a tag, are done', async () => {
    const a = await admin();
    const email = 'many@example.test';
    const passes = [];
    for (let i = 0; i < 150; i++)
      passes.push(await kit.scanPass(tpl, { plan: 'guest' }, { holderEmail: email }));
    const tags = passes.map((pass) => ({
      tagId: kit.fx.ids.id(),
      ref: kit.fx.ids.id().replace(/-/g, '').padEnd(64, 'b').slice(0, 64),
      pass,
    }));
    await kit.env.DB.batch(
      tags.flatMap((t) => [
        kit.env.DB.prepare(
          `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at)
           VALUES (?, ?, 'live', ?, 'uid', ?, 1)`,
        ).bind(t.tagId, kit.org.id, t.ref, t.ref.slice(0, 4).toUpperCase()),
        kit.env.DB.prepare(
          `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
           SELECT ?, ?, 'pass', id, 'admin', 1, 'user', 'admin-1', credential_generation FROM passes WHERE id = ?`,
        ).bind(kit.fx.ids.id(), t.tagId, t.pass.id),
      ]),
    );
    const req = { holderEmail: email, passes: 'void', tags: 'spare', dryRun: true } as const;
    expect(await offboard(kit.ctx, actor, a, req)).toEqual({
      dryRun: true,
      holders: 1,
      passes: 100,
      tags: 100,
      more: true,
    });
    const live = { ...req, dryRun: false };
    expect(await offboard(kit.ctx, actor, a, live)).toMatchObject({
      passes: 100,
      tags: 100,
      more: true,
    });
    expect(await offboard(kit.ctx, actor, a, live)).toMatchObject({
      passes: 50,
      tags: 50,
      more: false,
    });
    expect(await offboard(kit.ctx, actor, a, live)).toMatchObject({ passes: 0, more: false });
    const voided = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM passes WHERE holder_email = ? AND status = 'voided'",
      [email],
    );
    expect(voided).toHaveLength(150);
    const open = await first<{ n: number }>(
      kit.env.DB,
      `SELECT count(*) AS n FROM tag_bindings b JOIN passes p ON p.id = b.pass_id
       WHERE p.holder_email = ? AND b.ended_at IS NULL`,
      [email],
    );
    expect(open?.n).toBe(0);
  }, 120_000);
});
