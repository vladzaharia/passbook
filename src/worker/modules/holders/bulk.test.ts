import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { getPass } from '../passes/repo.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { blockedUsers } from './repo.ts';
import { assignHolder, assignHoldersBulk } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const admin = { type: 'user', id: 'admin-1' } as const;
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
      kit.ctx,
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
        kit.ctx,
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

  it('writes nothing when the email is unchanged', async () => {
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    await assignHolder(kit.ctx, admin, { passId: pass.id, email: e }, null);
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
