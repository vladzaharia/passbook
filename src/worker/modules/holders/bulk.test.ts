import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updateSettings } from '../settings/service.ts';
import { blockedUsers } from './repo.ts';
import { assignHolder, assignHoldersBulk } from './service.ts';
import { eventMember } from './test-auth-fixtures.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const admin = { type: 'system', id: null } as const;
const email = () =>
  `bulk-${kit.fx.ids.token(6).toLowerCase()}@example.com`.replace(/[^a-z0-9@.-]/g, 'x');
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;
const assignAudits = (passId: string) =>
  count("SELECT count(*) AS n FROM audit_log WHERE action = 'holder.assign' AND target_id = ?", [
    passId,
  ]);

describe('assign-bulk', () => {
  it('applies every item and returns them in order', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const ea = email();
    const eb = email();
    const out = await assignHoldersBulk(
      jobCtxOf(kit),
      admin,
      [
        { passId: a.id, email: ea },
        { passId: b.id, email: eb },
      ],
      null,
    );
    expect(out.map((h) => [h.passId, h.email, h.state])).toEqual([
      [a.id, ea, 'waiting'],
      [b.id, eb, 'waiting'],
    ]);
  });

  it('changes nothing when one item is outside the scope', async () => {
    const own = await kit.pass();
    const other = await makeOrg(kit.fx, { name: 'Foreign' });
    const foreign = await kit.pass({ orgId: other.id });
    await expect(
      assignHoldersBulk(
        jobCtxOf(kit),
        admin,
        [
          { passId: own.id, email: email() },
          { passId: foreign.id, email: email() },
        ],
        kit.org.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await getPass(kit.env.DB, own.id))?.holderEmail).toBeNull();
    expect(await assignAudits(own.id)).toBe(0);
  });

  it('applies every item when a settings save lands after authorization', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!session) throw new Error('Missing session fixture');
    const a = await kit.pass();
    const b = await kit.pass();
    const before = await first<{ access_revision: number; config_revision: number }>(
      kit.env.DB,
      'SELECT access_revision, config_revision FROM orgs WHERE id = ?',
      [kit.org.id],
    );
    const out = await assignHoldersBulk(
      jobCtxOf(kit),
      { type: 'user', id: member.user.id },
      [
        { passId: a.id, email: email() },
        { passId: b.id, email: email() },
      ],
      null,
      async (orgId) => {
        const authority = await tenantAuthorityOf(jobCtxOf(kit), session, orgId, 'passes:operate');
        await updateSettings(jobCtxOf(kit), admin, {
          scope: `org:${orgId}`,
          values: { 'support.email': `${kit.fx.ids.id()}@example.test` },
        });
        return authority;
      },
    );
    expect(out.map((h) => h.state)).toEqual(['waiting', 'waiting']);
    const after = await first<{ access_revision: number; config_revision: number }>(
      kit.env.DB,
      'SELECT access_revision, config_revision FROM orgs WHERE id = ?',
      [kit.org.id],
    );
    expect(after?.access_revision).toBe(before?.access_revision);
    expect(after?.config_revision).toBeGreaterThan(before?.config_revision ?? 0);
  });

  it('writes nothing when the email is unchanged', async () => {
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    await assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: e }, null);
    expect(await assignAudits(pass.id)).toBe(0);
  });

  it('reads blocks for more than 100 passes (D1 parameter limit)', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `missing-${i}`);
    expect((await blockedUsers(kit.env.DB, ids)).size).toBe(0);
    const pass = await kit.pass();
    const user = await makeUser(kit.fx);
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [pass.id, user.id],
    );
    expect((await blockedUsers(kit.env.DB, [...ids, pass.id])).get(pass.id)).toEqual([user.id]);
  });
});
