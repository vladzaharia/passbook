import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { first, run } from '../src/worker/platform/db.ts';
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
  it('strips scanning:admin from role-preset keys only, and is safe to run twice', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const scopes = ['scanning:write', 'scanning:admin', 'passes:read'];
    const preset = await makeApiKey(f, { orgId: org.id, scopes, roles: ['org_admin'] });
    const named = await makeApiKey(f, { orgId: org.id, scopes });
    const revoked = await makeApiKey(f, { orgId: org.id, scopes, roles: ['org_admin'] });
    await run(env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [revoked.id]);
    if (!migration) throw new Error('The migration is missing.');
    for (let pass = 0; pass < 2; pass++)
      for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(await scopesOf(preset.id)).toEqual(['scanning:write', 'passes:read']);
    expect(await scopesOf(named.id)).toEqual(scopes);
    expect(await scopesOf(revoked.id)).toEqual(scopes);
    // The identity guard is back.
    await expect(
      run(env.DB, "UPDATE api_keys SET scopes = '[]' WHERE id = ?", [named.id]),
    ).rejects.toThrow(/identity is immutable/);
  });
});
