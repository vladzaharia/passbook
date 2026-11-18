import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all, first, run } from '../src/worker/platform/db.ts';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from './helpers/index.ts';
import { makeJoinLink } from './helpers/join.ts';

const db = env.DB;

async function seed(label: string, mode: 'live' | 'test' = 'live') {
  const f = fixtures(await makeEnv());
  const org = await makeOrg(f);
  const template = makeTemplate({ id: `tpl-${label}` });
  const pass = await makePass(f, { orgId: org.id, template: template.resolved, mode });
  const link = await makeJoinLink(f, { orgId: org.id, templateId: template.resolved.id, mode });
  return { f, org, template, pass, link };
}

const issue = (x: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) => {
  const v = {
    id: x.f.ids.id(),
    link_id: x.link.id,
    org_id: x.org.id,
    mode: 'live',
    pass_id: x.pass.id,
    link_generation: 1,
    created_at: 1,
    ip_key: 'ip',
    device_key: 'dev',
    fields_hash: 'fh',
    ...over,
  };
  return run(
    db,
    `INSERT INTO join_issues (id, link_id, org_id, mode, pass_id, link_generation, created_at, ip_key, device_key, fields_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.id,
      v.link_id,
      v.org_id,
      v.mode,
      v.pass_id,
      v.link_generation,
      v.created_at,
      v.ip_key,
      v.device_key,
      v.fields_hash,
    ],
  );
};

describe('0090_join: join_links', () => {
  it('keeps org, mode and template for good', async () => {
    const x = await seed('jm-immutable');
    const other = await makeOrg(x.f);
    for (const [column, value] of [
      ['org_id', other.id],
      ['mode', 'test'],
      ['template_id', 'tpl-other'],
    ] as const)
      await expect(
        run(db, `UPDATE join_links SET ${column} = ? WHERE id = ?`, [value, x.link.id]),
        column,
      ).rejects.toThrow();
    await run(db, 'UPDATE join_links SET enabled = 0, generation = 2 WHERE id = ?', [x.link.id]);
  });

  it('checks the token, the limit and the test cap', async () => {
    const x = await seed('jm-checks');
    const insert = (token: string, mode: string, limit: number, extra = 'jm-t') =>
      run(
        db,
        `INSERT INTO join_links (id, org_id, mode, template_id, token, daily_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [x.f.ids.id(), x.org.id, mode, `${extra}-${mode}`, token, limit],
      );
    // template FK: use a real template for the accepted rows.
    await expect(insert('plain-token', 'live', 10)).rejects.toThrow();
    await expect(insert('h1:abc', 'staging', 10)).rejects.toThrow();
    await expect(insert('h1:abc', 'live', 0)).rejects.toThrow();
    await expect(insert('h1:abc', 'live', 5001)).rejects.toThrow();
    await expect(insert('h1:abd', 'test', 51)).rejects.toThrow();
    await run(db, 'UPDATE join_links SET daily_limit = 5000 WHERE id = ?', [x.link.id]);
    await expect(
      run(db, 'UPDATE join_links SET generation = 0 WHERE id = ?', [x.link.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE join_links SET enabled = 2 WHERE id = ?', [x.link.id]),
    ).rejects.toThrow();
  });

  it('allows a test link up to 50 and one link per org, mode and template', async () => {
    const x = await seed('jm-test-cap', 'test');
    await run(db, 'UPDATE join_links SET daily_limit = 50 WHERE id = ?', [x.link.id]);
    await expect(
      run(db, 'UPDATE join_links SET daily_limit = 51 WHERE id = ?', [x.link.id]),
    ).rejects.toThrow();
    await expect(
      run(
        db,
        `INSERT INTO join_links (id, org_id, mode, template_id, token, created_at, updated_at)
         VALUES ('dup', ?, 'test', ?, 'h1:dup', 1, 1)`,
        [x.org.id, x.template.resolved.id],
      ),
    ).rejects.toThrow();
  });

  it('goes with its template, and takes its seal and ledger along', async () => {
    const x = await seed('jm-cascade');
    await issue(x);
    await run(db, 'DELETE FROM join_links WHERE id = ?', [x.link.id]);
    expect(
      await first(db, 'SELECT count(*) AS n FROM join_link_seals WHERE link_id = ?', [x.link.id]),
    ).toEqual({ n: 0 });
    expect(
      await first(db, 'SELECT count(*) AS n FROM join_issues WHERE link_id = ?', [x.link.id]),
    ).toEqual({ n: 0 });
  });
});

describe('0090_join: join_issues', () => {
  it('takes a row whose org, mode and generation match its link and pass', async () => {
    const x = await seed('jm-issue-ok');
    await issue(x);
    expect(
      await first(db, 'SELECT count(*) AS n FROM join_issues WHERE link_id = ?', [x.link.id]),
    ).toEqual({ n: 1 });
  });

  it('refuses a cross-mode row: a live link with a test pass, or a test mode on a live link', async () => {
    const x = await seed('jm-issue-mode');
    const testPass = await makePass(x.f, {
      orgId: x.org.id,
      template: x.template.resolved,
      mode: 'test',
    });
    await expect(issue(x, { pass_id: testPass.id })).rejects.toThrow();
    await expect(issue(x, { mode: 'test' })).rejects.toThrow();
    await expect(issue(x, { mode: 'test', pass_id: testPass.id })).rejects.toThrow();
  });

  it("refuses another org, and a generation that is not the link's", async () => {
    const x = await seed('jm-issue-org');
    const other = await makeOrg(x.f);
    await expect(issue(x, { org_id: other.id })).rejects.toThrow();
    await expect(issue(x, { link_generation: 2 })).rejects.toThrow();
    await run(db, 'UPDATE join_links SET generation = 2 WHERE id = ?', [x.link.id]);
    await expect(issue(x, { link_generation: 1 })).rejects.toThrow();
    await issue(x, { link_generation: 2 });
  });

  it('is one row per pass', async () => {
    const x = await seed('jm-issue-unique');
    await issue(x);
    await expect(issue(x)).rejects.toThrow();
  });

  it('changes only by clearing its three keys', async () => {
    const x = await seed('jm-issue-immutable');
    await issue(x);
    const upd = (set: string, params: unknown[] = []) =>
      run(db, `UPDATE join_issues SET ${set} WHERE link_id = ?`, [
        ...(params as never[]),
        x.link.id,
      ]);
    for (const set of [
      'created_at = 9',
      'link_generation = 2',
      "org_id = 'o'",
      "mode = 'test'",
      "pass_id = 'p'",
      "link_id = 'l'",
      "id = 'i'",
      "ip_key = 'other'",
      "device_key = 'other'",
      "fields_hash = 'other'",
    ])
      await expect(upd(set), set).rejects.toThrow();
    await upd('ip_key = NULL, device_key = NULL, fields_hash = NULL');
    expect(
      await first(db, 'SELECT ip_key, device_key, fields_hash FROM join_issues WHERE link_id = ?', [
        x.link.id,
      ]),
    ).toEqual({ ip_key: null, device_key: null, fields_hash: null });
    // Once cleared, a key cannot be written back.
    await expect(upd("ip_key = 'back'")).rejects.toThrow();
  });

  it('goes with its pass', async () => {
    const x = await seed('jm-issue-pass');
    await issue(x);
    await run(db, 'DELETE FROM passes WHERE id = ?', [x.pass.id]);
    expect(
      await first(db, 'SELECT count(*) AS n FROM join_issues WHERE link_id = ?', [x.link.id]),
    ).toEqual({ n: 0 });
  });
});

describe('0090_join: query plans', () => {
  const plan = async (sql: string, params: unknown[]) =>
    (await all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, params as never[]))
      .map((r) => r.detail)
      .join('\n');

  it("counts a link's day by an index, never a scan", async () => {
    expect(
      await plan('SELECT COUNT(*) FROM join_issues ji WHERE ji.link_id = ? AND ji.created_at > ?', [
        'l',
        0,
      ]),
    ).toContain('join_issues_link_at');
    // The grant's check also names org and mode; the planner may pick either cap index.
    const full = await plan(
      'SELECT COUNT(*) FROM join_issues ji WHERE ji.link_id = ? AND ji.org_id = ? AND ji.mode = ? AND ji.created_at > ?',
      ['l', 'o', 'live', 0],
    );
    expect(full).toMatch(/join_issues_(link|org)_at/);
    expect(full).not.toContain('SCAN');
  });

  it("counts an org's day by join_issues_org_at", async () => {
    expect(
      await plan(
        'SELECT COUNT(*) FROM join_issues ji WHERE ji.org_id = ? AND ji.mode = ? AND ji.created_at > ?',
        ['o', 'live', 0],
      ),
    ).toContain('join_issues_org_at');
  });

  it('looks a device up by join_issues_device', async () => {
    expect(
      await plan(
        'SELECT fields_hash FROM join_issues WHERE device_key = ? AND link_id = ? AND created_at > ?',
        ['d', 'l', 0],
      ),
    ).toContain('join_issues_device');
  });

  it('finds the keys to clear by join_issues_keys_due', async () => {
    expect(
      await plan(
        'SELECT id FROM join_issues WHERE created_at < ? AND (ip_key IS NOT NULL OR device_key IS NOT NULL)',
        [0],
      ),
    ).toContain('join_issues_keys_due');
  });

  it('dedupes an email by passes_template_email', async () => {
    expect(
      await plan(
        "SELECT 1 FROM passes p WHERE p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.holder_email = ? AND p.status = 'active'",
        ['o', 'live', 't', 'a@b.co'],
      ),
    ).toContain('passes_template_email');
  });

  it('finds a link by its token without a scan', async () => {
    expect(await plan('SELECT id FROM join_links WHERE token = ?', ['h1:x'])).toMatch(
      /USING (COVERING )?INDEX/,
    );
  });
});
