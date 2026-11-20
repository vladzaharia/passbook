import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { addBind, bindChecks, tagGrant } from './repo-tags-write.ts';
import { bindTag } from './tags.ts';
import { reportTagLost, restoreTag, retireTag, updateTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture();
});

const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(f.kit.env.DB, sql, params))?.n ?? 0;
const audits = (action: string, tagId: string) =>
  count('SELECT count(*) AS n FROM audit_log WHERE action = ? AND target_id = ?', [action, tagId]);

async function lost() {
  const t = await f.org();
  const pass = await f.pass(t.org.id);
  const authority = await t.authority();
  const uid = f.nextUid();
  const { tag } = await bindTag(f.kit.ctx, authority, { uid, passId: pass.id, scope: 'pass' });
  await reportTagLost(f.kit.ctx, authority, tag.id);
  return { t, pass, authority, tag, uid };
}

describe('lost is kept on the tag', () => {
  it('survives a pass purge and a purge of ended bindings', async () => {
    const { t, pass, authority, tag, uid } = await lost();
    await run(f.kit.env.DB, 'DELETE FROM tag_bindings WHERE tag_id = ?', [tag.id]);
    await run(f.kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    const row = await first<{ lost_at: number | null; lost_by: string | null }>(
      f.kit.env.DB,
      'SELECT lost_at, lost_by FROM nfc_tags WHERE id = ?',
      [tag.id],
    );
    expect(row?.lost_by).toBe(authority.userId);
    expect(row?.lost_at).not.toBeNull();
    const next = await f.pass(t.org.id);
    await refused(
      bindTag(f.kit.ctx, authority, { uid, passId: next.id, scope: 'pass' }),
      'TAG_LOST',
    );
    await expect(
      run(
        f.kit.env.DB,
        `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
         VALUES ('raw-lost', ?, 'pass', ?, 'admin', 1, 'user', 'x', 0)`,
        [tag.id, next.id],
      ),
    ).rejects.toThrow(/tag_lost/);
    await refused(restoreTag(f.kit.ctx, authority, tag.id), 'TAG_HOLDER_CHANGED');
    const moved = await bindTag(f.kit.ctx, authority, {
      uid,
      passId: next.id,
      scope: 'pass',
      move: true,
    });
    expect(moved.tag.state).toBe('assigned');
    expect(
      await count('SELECT count(*) AS n FROM nfc_tags WHERE id = ? AND lost_at IS NULL', [tag.id]),
    ).toBe(1);
  });
});

describe('restore from lost', () => {
  it('is refused while the org switch is off, and writes one audit row when it works', async () => {
    const { t, authority, tag } = await lost();
    await run(
      f.kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":false}', 1)",
      [`org:${t.org.id}`],
    );
    f.kit.clock.advance(10_000);
    await refused(restoreTag(f.kit.ctx, authority, tag.id), 'TAGS_OFF');
    await run(
      f.kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":true}', 1)",
      [`org:${t.org.id}`],
    );
    // The settings cache is per isolate for a few seconds.
    f.kit.clock.advance(10_000);
    expect((await restoreTag(f.kit.ctx, authority, tag.id)).state).toBe('assigned');
    expect(await audits('tag.restore', tag.id)).toBe(1);
    expect(await audits('tag.bind', tag.id)).toBe(1);
  });
});

describe('retire', () => {
  it('ends a binding that a racing bind committed after the read', async () => {
    const t = await f.org();
    const [a, b] = [await f.pass(t.org.id), await f.pass(t.org.id)];
    const authority = await t.authority();
    const { tag } = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: a.id,
      scope: 'pass',
    });
    await run(
      f.kit.env.DB,
      "UPDATE tag_bindings SET ended_at = 1, ended_by_type = 'user', ended_by = 'x', end_cause = 'admin' WHERE tag_id = ?",
      [tag.id],
    );
    // After retire reads the tag, another bind commits.
    let raced = false;
    const db = new Proxy(f.kit.env.DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop, target).bind?.(target);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('FROM nfc_tags WHERE id = ?')) return statement;
          return {
            bind: (...args: unknown[]) => {
              const bound = statement.bind(...args);
              return {
                first: async () => {
                  const row = await bound.first();
                  if (!raced) {
                    raced = true;
                    await run(
                      target,
                      `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
                       VALUES ('raced', ?, 'pass', ?, 'admin', 2, 'user', 'x', 0)`,
                      [tag.id, b.id],
                    );
                  }
                  return row;
                },
              };
            },
          };
        };
      },
    }) as D1Database;
    const ctx = { ...f.kit.ctx, env: { ...f.kit.env, DB: db } };
    await retireTag(ctx, authority, tag.id);
    expect(raced).toBe(true);
    expect(
      await count('SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL', [
        tag.id,
      ]),
    ).toBe(0);
    const ended = await all<{ end_cause: string }>(
      f.kit.env.DB,
      "SELECT end_cause FROM tag_bindings WHERE id = 'raced'",
    );
    expect(ended).toEqual([{ end_cause: 'tag_retired' }]);
  });

  it('a trigger ends the binding when a tag is retired by a raw write', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const { tag } = await bindTag(f.kit.ctx, await t.authority(), {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    await run(f.kit.env.DB, "UPDATE nfc_tags SET status = 'retired' WHERE id = ?", [tag.id]);
    expect(
      await count('SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ? AND end_cause = ?', [
        tag.id,
        'tag_retired',
      ]),
    ).toBe(1);
  });
});

describe('a bind pins the pass holder it read', () => {
  it('is refused when the pass credential generation moved', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const authority = await t.authority();
    const g = tagGrant(
      f.kit.ctx,
      'org_mode.nfc.tag.bind',
      authority,
      bindChecks({ passId: pass.id, holderGeneration: 7, holderOwner: null }),
    );
    addBind(g, f.kit.ctx, {
      tagId: f.kit.ctx.ids.id(),
      newTag: { ref: 'e'.repeat(64), hint: 'EEEE', label: null, system: 'uid' },
      bindingId: f.kit.ctx.ids.id(),
      passId: pass.id,
      scope: 'pass',
      userId: null,
      end: null,
      holderGeneration: 7,
      holderOwner: null,
      clearsLost: false,
      source: 'admin',
      actor: { type: 'user', id: authority.userId },
      scannerId: null,
      orgId: t.org.id,
      mode: 'live',
    });
    await expect(g.commit()).rejects.toMatchObject({ code: 'TAG_HOLDER_CHANGED' });
  });
});

describe('labels', () => {
  it('write an audit row', async () => {
    const { t, authority, tag } = await lost();
    expect(t.org.id).toBeTruthy();
    await updateTag(f.kit.ctx, authority, tag.id, { label: 'Spare' });
    expect(await audits('tag.update', tag.id)).toBe(1);
  });
});
