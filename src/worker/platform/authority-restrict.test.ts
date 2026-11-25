// A key limited to templates or pass styles never sees or acts on another template's rows: in grants (writes),
// in reads, and by default for any table with no template dimension (docs: design-api-platform section 2.3).
import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { passRow } from './authority-checks.ts';
import { jsonSet } from './authority-expr.ts';
import { db, refusal } from './authority-ext-fixtures.ts';
import { authorityPredicate, tenantFilter } from './authority-read.ts';
import { columnOf, hasTemplateRef, partsOf, TEMPLATE_REFS } from './authority-restrict.ts';
import { visible, world } from './authority-restrict-fixtures.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import { all, first, run } from './db.ts';

async function setTitle(
  w: Awaited<ReturnType<typeof world>>,
  keyId: string,
  passId: string,
  require = false,
) {
  const g = grant(w.x.route, {
    purpose: 'org_mode.pass.publish',
    principal: w.principal(keyId),
    checks: require ? passRow(passId) : [],
  });
  g.update('passes', {
    set: { display_title: 'limit-test' },
    where: { id: passId },
    returning: ['id'],
    ...(require ? { require: 'one' as const } : {}),
  });
  return refusal(g.commit());
}

const titleOf = async (id: string) =>
  (
    await first<{ t: string | null }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
      id,
    ])
  )?.t;

describe('writes through a grant', () => {
  it('a limited key changes a pass of its template and no pass of another', async () => {
    const w = await world('rw');
    const key = await w.key({ templateIds: [w.a.id] });
    expect(await setTitle(w, key, w.a.pass)).toBeNull();
    expect(await setTitle(w, key, w.b.pass)).toBeNull();
    expect(await titleOf(w.a.pass)).toBe('limit-test');
    expect(await titleOf(w.b.pass)).not.toBe('limit-test');
  });

  it('a lineage check turns another template into a refusal, not a silent no-op', async () => {
    const w = await world('rw-one');
    const key = await w.key({ templateIds: [w.a.id] });
    expect(await setTitle(w, key, w.a.pass, true)).toBeNull();
    // Routes map a lineage refusal to their not-found code; the builder's own is LINEAGE_CHANGED (409).
    const refused = await setTitle(w, key, w.b.pass, true);
    expect(refused?.code).toBe('LINEAGE_CHANGED');
    expect(await titleOf(w.b.pass)).not.toBe('limit-test');
  });

  it('a key without limits still reaches every template', async () => {
    const w = await world('rw-free');
    const key = await w.key({});
    expect(await setTitle(w, key, w.a.pass, true)).toBeNull();
    expect(await setTitle(w, key, w.b.pass, true)).toBeNull();
  });

  it('a table with no template dimension is refused to a limited key and open to an unlimited one', async () => {
    const w = await world('rw-plain');
    const write = async (keyId: string) => {
      const g = grant(w.x.route, {
        purpose: 'org_mode.pass.publish',
        principal: w.principal(keyId),
      });
      g.update('settings', { set: { value: '1' }, where: { key: 'no-such-key' } });
      return (await refusal(g.commit()))?.code ?? null;
    };
    expect(await write(await w.key({ templateIds: [w.a.id] }))).toBe('ACTOR_CHANGED');
    expect(await write(await w.key({}))).toBeNull();
  });

  it('an insert names its template: a limited key inserts only rows of its templates', async () => {
    const w = await world('rw-ins');
    const key = await w.key({ templateIds: [w.a.id] });
    const event = async (passId: string) => {
      const g = grant(w.x.route, { purpose: 'org_mode.pass.publish', principal: w.principal(key) });
      g.insertSelect(
        'pass_events',
        ['id', 'pass_id', 'kind', 'at'],
        [`ev-${passId}`, passId, 'x', 1],
        {
          returning: ['id'],
        },
      );
      await g.commit();
    };
    await event(w.a.pass);
    await event(w.b.pass);
    const rows = await all<{ id: string }>(
      db,
      "SELECT id FROM pass_events WHERE kind = 'x' AND id LIKE 'ev-%'",
    );
    expect(rows.map((r) => r.id)).toEqual([`ev-${w.a.pass}`]);
  });

  it('a webhook endpoint lists its templates: none, all, or one outside the limit refuses the key', async () => {
    const w = await world('rw-hook');
    const key = await w.key({ templateIds: [w.a.id] });
    const endpoint = async (templates: string[] | null, id: string) => {
      const g = grant(w.x.route, {
        purpose: 'org_mode.webhook.create',
        principal: w.principal(key),
      });
      g.insertSelect(
        'webhook_endpoints',
        ['id', 'url', 'event_types', 'template_ids', 'api_version', 'created_at', 'updated_at'],
        [
          id,
          'https://example.test/h',
          '["pass.created"]',
          templates && JSON.stringify(templates),
          'v1',
          1,
          1,
        ],
        { returning: ['id'] },
      );
      await g.commit();
    };
    await endpoint(null, 'wh-all');
    await endpoint([w.b.id], 'wh-b');
    await endpoint([w.a.id, w.b.id], 'wh-ab');
    await endpoint([w.a.id], 'wh-a');
    const made = await all<{ id: string }>(
      db,
      "SELECT id FROM webhook_endpoints WHERE id LIKE 'wh-%'",
    );
    expect(made.map((r) => r.id)).toEqual(['wh-a']);
  });

  it('an upsert cannot reach, through its conflict target, a row of another template', async () => {
    const w = await world('rw-ups');
    const scan = (id: string, template: string) => ({
      cols: [
        'id',
        'actor_type',
        'actor_id',
        'actor_key',
        'idempotency_key',
        'request_hash',
        'method',
        'template_id',
        'at',
      ],
      values: [id, 'user', 'u', 'ak', 'same', `hash-${id}`, 'manual', template, 1],
    });
    const seed = scan('scan-b', w.b.id);
    await run(
      db,
      `INSERT INTO scans (${seed.cols.join(', ')}, org_id, mode) VALUES (${seed.cols.map(() => '?').join(', ')}, ?, 'live')`,
      [...seed.values, w.org.id],
    );
    const key = await w.key({ templateIds: [w.a.id] });
    const g = grant(w.x.route, { purpose: 'org_mode.pass.publish', principal: w.principal(key) });
    // The inserted row names the key's own template, but the row it would overwrite is the other template's.
    const mine = scan('scan-a', w.a.id);
    g.upsert('scans', mine.cols, mine.values, { update: ['request_hash'], returning: ['id'] });
    await g.commit();
    expect(await first(db, "SELECT request_hash AS v FROM scans WHERE id = 'scan-b'")).toEqual({
      v: 'hash-scan-b',
    });
    // The same upsert by an unlimited key does overwrite it: the guard is the limit, nothing else.
    const free = grant(w.x.route, {
      purpose: 'org_mode.pass.publish',
      principal: w.principal(await w.key({})),
    });
    free.upsert('scans', mine.cols, mine.values, { update: ['request_hash'], returning: ['id'] });
    await free.commit();
    expect(await first(db, "SELECT request_hash AS v FROM scans WHERE id = 'scan-b'")).toEqual({
      v: 'hash-scan-a',
    });
  });
});

describe('tables that hang off a pass', () => {
  it("a delete reaches rows of the key's templates only, for a table keyed by pass and for an org-less child", async () => {
    const w = await world('rw-child');
    for (const pass of [w.a.pass, w.b.pass]) {
      await run(
        db,
        "INSERT INTO pass_events (id, org_id, pass_id, mode, kind, at) VALUES (?, ?, ?, 'live', 'seed', 1)",
        [`seed-${pass}`, w.org.id, pass],
      );
      await run(
        db,
        "INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, created_at) VALUES (?, 'icon', 'k', 's', 1, 1)",
        [pass],
      );
    }
    const key = await w.key({ templateIds: [w.a.id] });
    const g = grant(w.x.route, { purpose: 'org_mode.pass.publish', principal: w.principal(key) });
    g.delete('pass_events', { where: { kind: 'seed' }, returning: ['id'] });
    g.joined('pass_assets', { where: { name: 'icon' }, delete: true, returning: ['pass_id'] });
    await g.commit();
    expect(
      (await all<{ id: string }>(db, "SELECT id FROM pass_events WHERE kind = 'seed'")).map(
        (r) => r.id,
      ),
    ).toEqual([`seed-${w.b.pass}`]);
    expect(
      (
        await all<{ pass_id: string }>(db, "SELECT pass_id FROM pass_assets WHERE name = 'icon'")
      ).map((r) => r.pass_id),
    ).toEqual([w.b.pass]);
  });

  it('a child reached only through a parent with no template dimension is refused to a limited key', async () => {
    const w = await world('rw-orphan');
    const write = async (keyId: string) => {
      const g = grant(w.x.route, {
        purpose: 'org_mode.pass.publish',
        principal: w.principal(keyId),
      });
      g.joined('bundle_passes', { where: { pass_id: w.a.pass }, delete: true });
      return (await refusal(g.commit()))?.code ?? null;
    };
    expect(await write(await w.key({ templateIds: [w.a.id] }))).toBe('ACTOR_CHANGED');
    expect(await write(await w.key({}))).toBeNull();
  });
});

describe('what a write assigns', () => {
  const codeOf = async (g: ReturnType<typeof grant>) => (await refusal(g.commit()))?.code ?? null;

  it('a limited key cannot move a row out of its templates by assigning the template column', async () => {
    const w = await world('as-move');
    const key = await w.key({ templateIds: [w.a.id] });
    const move = async (to: string) => {
      const g = grant(w.x.route, { purpose: 'org_mode.pass.publish', principal: w.principal(key) });
      g.update('passes', { set: { template_id: to }, where: { id: w.a.pass }, returning: ['id'] });
      await g.commit();
      return (
        await first<{ t: string }>(db, 'SELECT template_id AS t FROM passes WHERE id = ?', [
          w.a.pass,
        ])
      )?.t;
    };
    expect(await move(w.b.id)).toBe(w.a.id);
    expect(await move(w.a.id)).toBe(w.a.id);
  });

  it('nor widen a webhook endpoint to every template, by a value, a computed value or an upsert copy of a template column', async () => {
    const w = await world('as-widen');
    const key = await w.key({ templateIds: [w.a.id] });
    await run(
      db,
      `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, template_ids, api_version, created_at, updated_at)
       VALUES ('wh-own', ?, 'live', 'https://example.test/h', '["pass.created"]', ?, 'v1', 1, 1)`,
      [w.org.id, JSON.stringify([w.a.id])],
    );
    const attempt = (build: (g: ReturnType<typeof grant>) => void) => {
      const g = grant(w.x.route, {
        purpose: 'org_mode.webhook.update',
        principal: w.principal(key),
      });
      build(g);
      return g;
    };
    const ids = async () =>
      (
        await first<{ t: string | null }>(
          db,
          "SELECT template_ids AS t FROM webhook_endpoints WHERE id = 'wh-own'",
        )
      )?.t;
    const wide = attempt((g) =>
      g.update('webhook_endpoints', { set: { template_ids: null }, where: { id: 'wh-own' } }),
    );
    await wide.commit();
    expect(await ids()).toBe(JSON.stringify([w.a.id]));
    const other = attempt((g) =>
      g.update('webhook_endpoints', {
        set: { template_ids: JSON.stringify([w.a.id, w.b.id]) },
        where: { id: 'wh-own' },
      }),
    );
    await other.commit();
    expect(await ids()).toBe(JSON.stringify([w.a.id]));
    const computed = attempt((g) =>
      g.update('webhook_endpoints', {
        set: { template_ids: jsonSet('$.a', w.b.id) },
        where: { id: 'wh-own' },
      }),
    );
    expect(await codeOf(computed)).toBe('ACTOR_CHANGED');
    const copy = attempt((g) =>
      g.upsert(
        'pass_channels',
        ['pass_id', 'template_id', 'channel', 'set_by', 'set_at'],
        [w.a.pass, w.a.id, 'paper', 'key', 1],
        { copy: { template_id: 'set_by' } },
      ),
    );
    expect(await codeOf(copy)).toBe('ACTOR_CHANGED');
    const narrowing = attempt((g) =>
      g.update('webhook_endpoints', {
        set: { template_ids: JSON.stringify([w.a.id]), description: 'ok' },
        where: { id: 'wh-own' },
        returning: ['id'],
      }),
    );
    expect(await codeOf(narrowing)).toBeNull();
  });

  it('an insert that omits the template column is refused, not run as a no-op', async () => {
    const w = await world('as-omit');
    const key = await w.key({ templateIds: [w.a.id] });
    const g = grant(w.x.route, { purpose: 'org_mode.pass.publish', principal: w.principal(key) });
    g.insertSelect('pass_events', ['id', 'kind', 'at'], ['ev-omit', 'x', 1]);
    expect(await codeOf(g)).toBe('ACTOR_CHANGED');
  });

  it('a lineage check in a read refuses a pass of another template', async () => {
    const w = await world('as-read');
    const key = await w.key({ templateIds: [w.a.id] });
    const open = async (passId: string) => {
      const p = authorityPredicate(w.principal(key, 'passes:read'), {
        scope: 'org_mode',
        now: w.x.s.f.clock.now(),
        checks: passRow(passId),
      });
      return all(db, `WITH ${p.ctes} SELECT 1 AS ok FROM actor_ok`, p.params);
    };
    expect(await open(w.a.pass)).toHaveLength(1);
    expect(await open(w.b.pass)).toEqual([]);
  });

  it('a delivery is limited by its event, not only by the endpoint that was wider before', async () => {
    const w = await world('as-deliv');
    const key = await w.key({ templateIds: [w.a.id] });
    await run(
      db,
      `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, template_ids, api_version, created_at, updated_at)
       VALUES ('wh-d', ?, 'live', 'https://example.test/h', '["pass.created"]', ?, 'v1', 1, 1)`,
      [w.org.id, JSON.stringify([w.a.id])],
    );
    const feed = async (template: { id: string; pass: string }) => {
      const r = await first<{ seq: number }>(
        db,
        `INSERT INTO event_feed (event_id, org_id, mode, pass_id, template_id, type, kind, data, at)
         VALUES (?, ?, 'live', ?, ?, 't', 'k', '{}', 1) RETURNING seq`,
        [`evt-${template.id}`, w.org.id, template.pass, template.id],
      );
      await run(
        db,
        "INSERT INTO webhook_deliveries (endpoint_id, event_seq, org_id, mode) VALUES ('wh-d', ?, ?, 'live')",
        [r?.seq ?? 0, w.org.id],
      );
      return r?.seq;
    };
    const mine = await feed(w.a);
    await feed(w.b);
    const p = authorityPredicate(w.principal(key, 'passes:read'), {
      scope: 'org_mode',
      now: w.x.s.f.clock.now(),
    });
    const seen = await all<{ event_seq: number }>(
      db,
      `WITH ${p.ctes} SELECT x.event_seq FROM webhook_deliveries x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('x', 'webhook_deliveries')}`,
      p.params,
    );
    expect(seen.map((r) => r.event_seq)).toEqual([mine]);
  });
});

describe('pass styles', () => {
  it('a style limit reaches a template only when every one of its styles is allowed, and none passes', async () => {
    const w = await world('st');
    const key = await w.key({ passStyles: ['coupon'] });
    expect(await visible(w.x, w.principal(key), [w.a.pass, w.b.pass, w.c.pass])).toEqual([
      w.a.pass,
    ]);
    // A template that gains a style stops matching with no write to the key.
    await run(db, 'UPDATE templates SET styles = \'["coupon","storeCard"]\' WHERE id = ?', [
      w.a.id,
    ]);
    expect(await visible(w.x, w.principal(key), [w.a.pass, w.b.pass, w.c.pass])).toEqual([]);
  });

  it('a style that is not text never passes the limit', async () => {
    const w = await world('st-null');
    await run(db, 'UPDATE templates SET styles = \'["coupon", null]\' WHERE id = ?', [w.a.id]);
    const key = await w.key({ passStyles: ['coupon'] });
    expect(await visible(w.x, w.principal(key), [w.a.pass])).toEqual([]);
  });

  it('templates and styles together narrow further, never widen', async () => {
    const w = await world('st-both');
    const both = await w.key({ templateIds: [w.a.id, w.b.id], passStyles: ['coupon'] });
    expect(await visible(w.x, w.principal(both), [w.a.pass, w.b.pass, w.c.pass])).toEqual([
      w.a.pass,
    ]);
    const named = await w.key({ templateIds: [w.a.id, w.b.id] });
    expect((await visible(w.x, w.principal(named), [w.a.pass, w.b.pass, w.c.pass])).sort()).toEqual(
      [w.a.pass, w.b.pass].sort(),
    );
  });

  it('a style limit never reaches another org, nor a template of its own org named elsewhere', async () => {
    const w = await world('st-org');
    const other = await world('st-org-other');
    const key = await w.key({ passStyles: ['coupon'] });
    expect(await visible(w.x, w.principal(key), [w.a.pass, other.a.pass])).toEqual([w.a.pass]);
  });
});

describe('reads', () => {
  it('a limited key reads rows of its templates only; an unlimited key reads the whole org', async () => {
    const w = await world('rd');
    const ids = [w.a.pass, w.b.pass];
    expect(await visible(w.x, w.principal(await w.key({ templateIds: [w.a.id] })), ids)).toEqual([
      w.a.pass,
    ]);
    expect(await visible(w.x, w.principal(await w.key({})), ids)).toEqual([...ids].sort());
  });

  it('a limit only narrows: what a limited key reads is inside what the same key reads without the limit', async () => {
    const w = await world('rd-sub');
    const ids = [w.a.pass, w.b.pass, w.c.pass];
    const free = await visible(w.x, w.principal(await w.key({})), ids);
    for (const limit of [
      { templateIds: [w.a.id] },
      { templateIds: [w.b.id, w.c.id] },
      { passStyles: ['coupon'] },
    ])
      for (const row of await visible(w.x, w.principal(await w.key(limit)), ids))
        expect(free).toContain(row);
  });

  it('a limited key reads no row of a table with no template dimension', async () => {
    const w = await world('rd-plain');
    const read = async (keyId: string) => {
      const p = authorityPredicate(w.principal(keyId), { scope: 'org', now: w.x.s.f.clock.now() });
      return all(
        db,
        `WITH ${p.ctes} SELECT s.key FROM settings s WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('s', 'settings', 'org')}`,
        p.params,
      );
    };
    await run(
      db,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, 'k', '1', 1)",
      [`org:${w.org.id}`],
    );
    expect((await read(await w.key({}))).length).toBeGreaterThan(0);
    expect(await read(await w.key({ templateIds: [w.a.id] }))).toEqual([]);
  });
});

describe('the corpus: every table with a template column is covered', () => {
  /** Guarded tables that carry a template or pass column and that a limited key is refused, with the reason. */
  const REFUSED: Record<string, string> = {
    connections: 'default_template_id configures a sync; a connection is not a template resource',
    bundles: 'a bundle holds passes of several templates',
    bundle_passes: 'reached through a bundle, which has no template',
    tag_bindings: 'reached through an NFC tag, which has no template',
    nfc_tag_type_templates: 'reached through a tag type, which spans templates',
    scan_event_templates: 'reached through an event, which spans templates',
    scanner_templates: 'reached through a scanner, which spans templates',
    pass_import_rows: 'checked through its import (an org-less child), not as its own table',
    template_version_bases: 'checked through its fork (an org-less child)',
    template_approvals: 'checked through its candidate (an org-less child)',
    pass_assets: 'checked through its pass (an org-less child)',
    token_remac_marks: 'checked through its pass (an org-less child)',
    channel_apply_marks: 'reached through a run; no direct template read',
    data_request_passes: 'reached through a data request, which has no template',
    wallet_enrolment_events: 'no template column',
    scan_zones: 'no template column',
    scan_staff: 'no template column',
    captured_emails: 'the sandbox inbox is org-wide; pass_id is a link, not a template',
    connection_runs: 'reached through a connection, which has no template',
    tag_enrollments: 'an NFC enrolment has no template',
    retention_holds: 'a hold is org-level',
  };

  async function columnsOf(table: string): Promise<string[]> {
    const rows = await all<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`);
    return rows.map((r) => r.name);
  }

  it('each guarded table with a template or pass column has a template reference, or is refused with a stated reason', async () => {
    const unexplained: string[] = [];
    for (const table of Object.keys(GUARDED_TABLES)) {
      const columns = await columnsOf(table);
      const names = columns.some((c) => /^(template_id|template_ids|pass_id|endpoint_id)$/.test(c));
      const edgeParent = (GUARDED_TABLES[table]?.edges ?? []).some((e) => hasTemplateRef(e.parent));
      if ((names || edgeParent) && !hasTemplateRef(table) && !(table in REFUSED))
        unexplained.push(table);
    }
    expect(unexplained).toEqual([]);
  });

  it('each reference names a column that exists, and its parent has a reference', async () => {
    for (const [table, ref] of Object.entries(TEMPLATE_REFS)) {
      expect(GUARDED_TABLES[table], `${table} is guarded`).toBeDefined();
      for (const part of partsOf(ref)) {
        expect(await columnsOf(table), `${table}.${columnOf(part)}`).toContain(columnOf(part));
        if ('parent' in part) {
          expect(hasTemplateRef(part.parent), `${table} parent`).toBe(true);
          expect(await columnsOf(part.parent), `${part.parent}.${part.key ?? 'id'}`).toContain(
            part.key ?? 'id',
          );
        }
      }
    }
  });

  it('the read filter of every org table compiles for a limited key and sees no foreign row of any', async () => {
    const w = await world('corpus');
    const keyId = await w.key({ templateIds: [w.a.id] });
    for (const [table, scope] of Object.entries(GUARDED_TABLES)) {
      if (scope.org === null || scope.platform) continue;
      const p = authorityPredicate(w.principal(keyId), {
        scope: scope.mode ? 'org_mode' : 'org',
        now: w.x.s.f.clock.now(),
      });
      const alias = 'x';
      const sql = `WITH ${p.ctes} SELECT count(*) AS n FROM ${table} ${alias} WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter(alias, table, scope.mode ? 'org_mode' : 'org')}`;
      const row = await first<{ n: number }>(db, sql, p.params);
      expect(row, table).not.toBeNull();
    }
  });

  it('every mapped table filters to the limited key: the other template has no visible row', async () => {
    const w = await world('corpus-rows');
    const keyId = await w.key({ templateIds: [w.a.id] });
    const seen = async (table: string, scope: 'org' | 'org_mode') => {
      const p = authorityPredicate(w.principal(keyId), { scope, now: w.x.s.f.clock.now() });
      return first<{ n: number }>(
        db,
        `WITH ${p.ctes} SELECT count(*) AS n FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('x', table, scope)} AND ${
          'column' in (TEMPLATE_REFS[table] ?? {})
            ? `x.${(TEMPLATE_REFS[table] as { column: string }).column} = ?`
            : '1 = 1'
        }`,
        'column' in (TEMPLATE_REFS[table] ?? {}) ? [...p.params, w.b.id] : p.params,
      );
    };
    for (const [table, ref] of Object.entries(TEMPLATE_REFS))
      if ('column' in ref && !('parent' in ref))
        expect(
          (await seen(table, GUARDED_TABLES[table]?.mode ? 'org_mode' : 'org'))?.n,
          table,
        ).toBe(0);
  });
});
