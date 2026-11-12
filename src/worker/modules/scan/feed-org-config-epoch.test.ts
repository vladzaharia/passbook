// The feed keeps a scan's pass across an org rename (config_revision is settings, not authority);
// a suspension (access_revision) between the page read and its output still withholds it.
import { describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  get,
  kit,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';

setupPrivacyKit();

type Change = 'rename' | 'suspend';

/** Apply `kind` once, right after the feed's page read and before its output fence. */
async function pageRacing(kind: Change) {
  const db = kit.env.DB;
  let raced = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'all')
          return async () => {
            const result = await target.all();
            if (!raced) {
              raced = true;
              if (kind === 'rename')
                await runOne(db, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [
                  kit.org.id,
                ]);
              else
                for (const status of ['suspended', 'active'])
                  await runOne(db, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return /FROM\s+scans\s+s[\s\S]*ORDER BY s\.at DESC/i.test(sql)
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const response = await get(`?orgId=${kit.org.id}`);
    expect(raced).toBe(true);
    return response;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

describe('scan feed and the org epochs', () => {
  it('keeps a feed row and its pass when an org rename races the page', async () => {
    const pass = await privatePass();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await recordedCheckIn(scanner, pass.id);
    await runOne(kit.env.DB, "UPDATE orgs SET name = name || ' (before)' WHERE id = ?", [
      kit.org.id,
    ]);
    const response = await pageRacing('rename');
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { id: string; passId: string | null }[] };
    expect(page.items.find((item) => item.id === row.id)).toMatchObject({
      passId: pass.id,
      passTitle: PUBLIC,
    });
  });

  it('withholds the pass when a suspension races the page', async () => {
    const pass = await privatePass();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await recordedCheckIn(scanner, pass.id);
    const response = await pageRacing('suspend');
    const text = await response.text();
    expect(text).not.toContain(PUBLIC);
    if (response.status === 200) {
      const page = JSON.parse(text) as { items: { id: string; passId: string | null }[] };
      expect(page.items.find((item) => item.id === row.id)?.passId ?? null).toBeNull();
    }
  });
});
