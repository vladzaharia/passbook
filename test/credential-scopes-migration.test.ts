import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all, first, run } from '../src/worker/platform/db.ts';
import { fixtures, makeApiKey, makeEnv, makeOrg } from './helpers/index.ts';

type Migration = { name: string; queries: string[] };
const migration = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS.find((m) =>
  m.name.endsWith('_credential_scopes_out_of_presets.sql'),
);

const scopesOf = async (id: string) =>
  JSON.parse(
    (await first<{ scopes: string }>(env.DB, 'SELECT scopes FROM api_keys WHERE id = ?', [id]))
      ?.scopes ?? '[]',
  );

describe('credential scopes out of presets migration', () => {
  it('strips scanning:admin from rule-breaking keys only, records each, and is safe to run twice', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const scopes = ['scanning:write', 'scanning:admin', 'passes:read'];
    const kept = ['scanning:write', 'passes:read'];
    const soon = f.clock.now() + 30 * 86_400_000;
    const preset = await makeApiKey(f, {
      orgId: org.id,
      scopes,
      roles: ['org_admin'],
      expiresAt: soon,
    });
    const open = await makeApiKey(f, { orgId: org.id, scopes });
    const long = await makeApiKey(f, {
      orgId: org.id,
      scopes,
      expiresAt: f.clock.now() + 200 * 86_400_000,
    });
    const named = await makeApiKey(f, { orgId: org.id, scopes, expiresAt: soon });
    const revoked = await makeApiKey(f, { orgId: org.id, scopes, roles: ['org_admin'] });
    await run(env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [revoked.id]);
    if (!migration) throw new Error('The migration is missing.');
    const audit = () =>
      all<{ target_id: string; org_id: string; actor_type: string }>(
        env.DB,
        "SELECT target_id, org_id, actor_type FROM audit_log WHERE action = 'api_key.scope_removed' ORDER BY target_id",
      );
    for (let pass = 0; pass < 2; pass++) {
      for (const query of migration.queries) await env.DB.prepare(query).run();
      const rows = (await audit()).filter((r) => r.org_id === org.id);
      expect(rows.map((r) => r.target_id).sort()).toEqual([preset.id, open.id, long.id].sort());
      expect(rows.every((r) => r.actor_type === 'system')).toBe(true);
    }
    expect(await scopesOf(preset.id)).toEqual(kept);
    expect(await scopesOf(open.id)).toEqual(kept);
    expect(await scopesOf(long.id)).toEqual(kept);
    expect(await scopesOf(named.id)).toEqual(scopes);
    expect(await scopesOf(revoked.id)).toEqual(scopes);
    await expect(
      run(
        env.DB,
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, parent_key_id)
         VALUES ('child-cred', ?, 'c', 'cpfx', 'chash', '["scanning:admin"]', 'live', 1, 'service', ?)`,
        [org.id, named.id],
      ),
    ).rejects.toThrow(/child/);
    await expect(
      run(env.DB, "UPDATE api_keys SET scopes = '[]' WHERE id = ?", [named.id]),
    ).rejects.toThrow(/identity is immutable/);
  });
});
