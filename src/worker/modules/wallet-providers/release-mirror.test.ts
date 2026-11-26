// The release table every migration leaves (0226) equals RELEASE, its rows are fixed, and a release goes back to dark
// only once every copy of that provider and mode is retired.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { RELEASE } from './release.ts';

const db = () => (env as AppEnv).DB;
const setState = (state: string, provider = 'google', mode = 'test') =>
  run(
    db(),
    'UPDATE wallet_provider_releases SET state = ?, changed_at = 1 WHERE provider = ? AND mode = ?',
    [state, provider, mode],
  );

describe('wallet_provider_releases', () => {
  it('equals RELEASE after every migration', async () => {
    const rows = await all<{
      provider: 'google' | 'samsung';
      mode: 'live' | 'test';
      state: string;
    }>(db(), 'SELECT provider, mode, state FROM wallet_provider_releases ORDER BY provider, mode');
    expect(rows).toHaveLength(4);
    for (const row of rows)
      expect(row.state, `${row.provider} ${row.mode}`).toBe(RELEASE[row.provider][row.mode]);
  });

  it('keeps its four rows', async () => {
    await expect(
      run(db(), "INSERT INTO wallet_provider_releases VALUES ('google', 'test', 'dark', 0)"),
    ).rejects.toThrow('fixed');
    await expect(run(db(), 'DELETE FROM wallet_provider_releases')).rejects.toThrow('fixed');
    await expect(
      run(db(), "UPDATE wallet_provider_releases SET mode = 'live' WHERE provider = 'google'"),
    ).rejects.toThrow();
    await expect(setState('open')).rejects.toThrow();
  });

  it('goes back to dark past placeholders that never reached a wallet', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate().resolved,
      mode: 'test',
    });
    await setState('released');
    await withoutTrigger(db(), 'wallet_provider_generation_insert_guard', () =>
      run(
        db(),
        `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at)
         VALUES ('dark-copy', ?, ?, 'test', 'google', 1, 'blocked', 0, 1, 1)`,
        [pass.id, org.id],
      ),
    );
    await setState('draining');
    await setState('dark');
    expect(
      await all(db(), "SELECT state FROM wallet_provider_releases WHERE provider = 'google'"),
    ).toEqual([{ state: 'dark' }, { state: 'dark' }]);
  });
});
