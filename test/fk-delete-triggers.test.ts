import { env as baseEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { first, run } from '../src/worker/platform/db.ts';
import { makeEnv } from './helpers/env.ts';
import { fixtures, makeOrg, makeTemplate, persistTemplate } from './helpers/factories.ts';

const count = async (sql: string, id: string) =>
  (await first<{ n: number }>(baseEnv.DB, sql, [id]))?.n;

describe('foreign-key deletes through triggers', () => {
  it('deletes an org that owns a fork with version bases', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const upstream = makeTemplate({ id: 'tpl-upstream' });
    const fork = makeTemplate({ id: 'tpl-fork', orgId: org.id });
    await persistTemplate(f, upstream.resolved, { registry: upstream.registry });
    await persistTemplate(f, fork.resolved, { registry: fork.registry });
    await run(
      f.env.DB,
      'INSERT INTO template_forks (template_id, org_id, upstream_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      [fork.resolved.id, org.id, upstream.resolved.id],
    );
    await run(
      f.env.DB,
      `INSERT INTO template_version_bases (template_id, version, upstream_id, upstream_version, via, created_at)
       VALUES (?, ?, ?, ?, 'fork', 1)`,
      [fork.resolved.id, fork.resolved.version, upstream.resolved.id, upstream.resolved.version],
    );
    await run(f.env.DB, 'DELETE FROM orgs WHERE id = ?', [org.id]);
    expect(await count('SELECT count(*) AS n FROM orgs WHERE id = ?', org.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM template_forks WHERE org_id = ?', org.id)).toBe(
      0,
    );
    expect(
      await count(
        'SELECT count(*) AS n FROM template_version_bases WHERE template_id = ?',
        fork.resolved.id,
      ),
    ).toBe(0);
  });
});
