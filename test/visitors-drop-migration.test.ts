/// <reference types="vite/client" />

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import visitorsTable from '../migrations/0121_visitors.sql?raw';
import developerSandbox from '../migrations/0156_developer_sandbox.sql?raw';
import { all, first, run } from '../src/worker/platform/db.ts';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from './helpers/index.ts';

type Migration = { name: string; queries: string[] };
const drop = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS.find((m) =>
  m.name.endsWith('_drop_visitors.sql'),
);

/** The statements of a migration file, comments removed. */
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
const trigger = statements(developerSandbox).find((s) =>
  s.startsWith('CREATE TRIGGER visitors_developer_no_live'),
);

const objects = () =>
  all<{ type: string; name: string }>(
    env.DB,
    "SELECT type, name FROM sqlite_master WHERE name LIKE 'visitors%'",
  );

describe('0215_drop_visitors migration', () => {
  it('drops the table, its index and its trigger, and a database with visitor rows migrates cleanly', async () => {
    if (!drop || !trigger) throw new Error('The migration or the trigger is missing.');
    // The test database is already migrated: bring the old shape back, with rows, as production has it.
    for (const sql of [...statements(visitorsTable), trigger]) await run(env.DB, sql);
    expect((await objects()).map((o) => o.type).sort()).toEqual(['index', 'table', 'trigger']);

    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate({ id: 'tpl-visitors-drop' });
    const live = await makePass(f, { orgId: org.id, template: template.resolved, mode: 'live' });
    const test = await makePass(f, { orgId: org.id, template: template.resolved, mode: 'test' });
    for (const [pass, mode] of [
      [live, 'live'],
      [test, 'test'],
    ] as const)
      await run(
        env.DB,
        `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, created_at)
         VALUES (?, ?, ?, ?, 'Leo Park', 'Ana Ruiz', 'ana@host.test', 1, 2, 1)`,
        [`visitor-${mode}`, org.id, mode, pass.id],
      );
    expect((await first<{ n: number }>(env.DB, 'SELECT count(*) AS n FROM visitors'))?.n).toBe(2);

    for (const query of drop.queries) await env.DB.prepare(query).run();
    expect(await objects()).toEqual([]);
    // Nothing else went with it.
    const kept = await first<{ n: number }>(
      env.DB,
      'SELECT count(*) AS n FROM passes WHERE org_id = ?',
      [org.id],
    );
    expect(kept?.n).toBe(2);
    expect(await first(env.DB, 'SELECT id FROM orgs WHERE id = ?', [org.id])).toEqual({
      id: org.id,
    });

    // Safe to run again.
    for (const query of drop.queries) await env.DB.prepare(query).run();
    expect(await objects()).toEqual([]);
  });

  it('is deterministic: no clock, no randomness', () => {
    const text = drop?.queries.join('\n') ?? '';
    expect(text).toMatch(/DROP TABLE/);
    expect(text).not.toMatch(/now|random|datetime|strftime|current_/i);
  });
});
