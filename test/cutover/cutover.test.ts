import { describe, expect, it } from 'vitest';
import { buildBootstrap, snapshotSql } from '../../tools/lib/bootstrap-tenancy.ts';
import { missingSecrets, parseVersionId } from '../../tools/lib/deploy-plan.ts';
import { makeEnv } from '../helpers/index.ts';

const NOW = 1_800_000_000_000;

describe('deploy plan', () => {
  it('lists required secrets the Worker lacks', () => {
    const listed = JSON.stringify([{ name: 'KEK_V1', type: 'secret_text' }]);
    expect(missingSecrets(['KEK_V1', 'TURNSTILE_SECRET'], listed)).toEqual(['TURNSTILE_SECRET']);
    expect(missingSecrets(['KEK_V1'], '{}')).toEqual(['KEK_V1']);
  });

  it('reads the uploaded version id from the output file or the log', () => {
    const id = '3f1c2d4e-0000-4000-8000-123456789abc';
    const file = `{"type":"wrangler-session"}\n{"type":"version-upload","version_id":"${id}"}\n`;
    expect(parseVersionId(file, '')).toBe(id);
    expect(parseVersionId('', `Worker Version ID: ${id}\n`)).toBe(id);
    expect(parseVersionId('', 'nothing')).toBeNull();
  });
});

async function seed(db: D1Database) {
  const at = 1_700_000_000_000;
  const statements = [
    `INSERT INTO users (id, primary_email, status, created_at) VALUES ('u-owner', 'owner@example.com', 'active', ${at})`,
    `INSERT INTO orgs (id, slug, name, status, branding, created_at, updated_at) VALUES
      ('org-a', 'org-a', 'A', 'active', '{}', ${at}, ${at}), ('org-b', 'org-b', 'B', 'active', '{}', ${at}, ${at}),
      ('org-x', 'org-x', 'X', 'deleted', '{}', ${at}, ${at})`,
    `INSERT INTO templates (id, org_id, slug, name, origin, active_version, status, created_at, updated_at)
      VALUES ('t-a', 'org-a', 'a', 'A', 'uploaded', 'v2', 'active', ${at}, ${at}),
        ('t-old', 'org-a', 'old', 'Old', 'uploaded', 'v1', 'archived', ${at}, ${at})`,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_at) VALUES
      ('t-a', 'v1', '{}', '{}', '[]', '{"ok":true}', ${at}), ('t-a', 'v2', '{"n":2}', '{}', '[]', '{"ok":true}', ${at}),
      ('t-old', 'v1', '{}', '{}', '[]', '{"ok":true}', ${at})`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

async function bootstrap(db: D1Database) {
  const row = await db.prepare(snapshotSql('owner@example.com')).first<{ snapshot: string }>();
  const snapshot = JSON.parse(row?.snapshot ?? '{}');
  const result = await buildBootstrap(
    {
      owner: snapshot.owner ?? null,
      orgs: snapshot.orgs ?? [],
      templates: snapshot.templates ?? [],
    },
    'owner@example.com',
    NOW,
  );
  const statements = result.sql
    .split(/;\n(?=INSERT)/)
    .map((s) =>
      s
        .replace(/^--.*\n/, '')
        .replace(/\s*\n\s*/g, ' ')
        .trim()
        .replace(/;$/, ''),
    )
    .filter(Boolean);
  for (const sql of statements) await db.prepare(sql).run();
  return result;
}

describe('bootstrap-tenancy', () => {
  it('adds one org_admin membership per live org and a legacy release per uploaded template', async () => {
    const { DB } = await makeEnv();
    await seed(DB);
    const first = await bootstrap(DB);
    expect(first.plan).toHaveLength(3);

    const members = await DB.prepare(
      `SELECT m.org_id, m.roles, i.accepted_at FROM org_memberships m JOIN org_invitations i ON i.id = m.invitation_id
       WHERE m.user_id = 'u-owner' AND m.revoked_at IS NULL ORDER BY m.org_id`,
    ).all<{ org_id: string; roles: string; accepted_at: number }>();
    expect(members.results.map((r) => [r.org_id, r.roles, r.accepted_at])).toEqual([
      ['org-a', '["org_admin"]', NOW],
      ['org-b', '["org_admin"]', NOW],
    ]);
    const releases = await DB.prepare(
      'SELECT template_id, org_id, mode, provider, generation, version, source, action FROM template_releases',
    ).all();
    expect(releases.results).toEqual([
      {
        template_id: 't-a',
        org_id: 'org-a',
        mode: 'live',
        provider: 'apple',
        generation: 1,
        version: 'v2',
        source: 'legacy',
        action: 'legacy',
      },
    ]);
    const audited = await DB.prepare(
      "SELECT action FROM audit_log WHERE action LIKE '%.bootstrap' ORDER BY action",
    ).all<{ action: string }>();
    expect(audited.results.map((r) => r.action)).toEqual([
      'org_membership.bootstrap',
      'org_membership.bootstrap',
      'template_release.bootstrap',
    ]);

    const second = await bootstrap(DB);
    expect(second.plan).toEqual([]);
    expect(
      (await DB.prepare('SELECT count(*) c FROM org_memberships').first<{ c: number }>())?.c,
    ).toBe(2);

    // A second legacy release for the same scope is refused.

    const insert = DB.prepare(
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
        content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at,
        previous_release_id)
       VALUES ('dup', 't-a', 'org-a', 'live', 'apple', 2, 'v2', ?1, ?1, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', 1,
        (SELECT id FROM template_releases WHERE template_id = 't-a'))`,
    ).bind('a'.repeat(64));
    await expect(insert.run()).rejects.toThrow();
  });

  it('refuses an unknown owner', async () => {
    await expect(
      buildBootstrap({ owner: null, orgs: [], templates: [] }, 'nobody@example.com', NOW),
    ).rejects.toThrow('No user nobody@example.com');
  });
});
