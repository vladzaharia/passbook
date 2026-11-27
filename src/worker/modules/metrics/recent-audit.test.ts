import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { recentAudit } from './repo.ts';

let f: ReturnType<typeof fixtures>;
beforeAll(async () => {
  f = fixtures(await makeEnv());
});

describe('recentAudit for a key', () => {
  it('leaves out rows that target a personal org, even with no org_id', async () => {
    const owner = await makeUser(f);
    const personal = await makeOrg(f, { personalUserId: owner.id });
    const regular = await makeOrg(f);
    const at = f.clock.now();
    const insert = (org: string | null, target: string | null, type: string | null) =>
      run(
        env.DB,
        "INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id) VALUES (?, ?, 'system', 'probe.recent', ?, ?)",
        [at, org, type, target],
      );
    await insert(regular.id, null, null);
    await insert(personal.id, null, null);
    await insert(null, personal.id, 'org');
    await insert(null, regular.id, 'org');
    const rows = (await recentAudit(env.DB, { mode: 'live' }, 50, false, true)).filter(
      (r) => r.action === 'probe.recent',
    );
    expect(rows.map((r) => [r.org_id, r.target_id]).sort()).toEqual(
      [
        [regular.id, null],
        [null, regular.id],
      ].sort(),
    );
    const all = (await recentAudit(env.DB, { mode: 'live' }, 50, false, false)).filter(
      (r) => r.action === 'probe.recent',
    );
    expect(all).toHaveLength(4);
  });
});
