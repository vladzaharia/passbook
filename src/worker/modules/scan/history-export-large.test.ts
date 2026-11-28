import { describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { exportPath, get, kit, PUBLIC, setupPrivacyKit } from './console-privacy-test-fixtures.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';
import { codeOf, key } from './test-kit.ts';

setupPrivacyKit();

const ROWS = 1000;
const MANIFEST_PADDING = 50_000;

/** Copy one signed scan `ROWS - 1` times: new ids and times, the same pass, event facts and manifest. */
async function clones(scanId: string) {
  const columns = (
    await kit.env.DB.prepare('PRAGMA table_info(scans)').all<{ name: string }>()
  ).results.map((column) => column.name);
  const copied = columns.map((name) => {
    if (name === 'id') return "printf('clone-%04d', n)";
    if (name === 'idempotency_key') return "printf('clone-key-%04d', n)";
    if (name === 'at') return 's.at + n';
    return `s.${name}`;
  });
  const db = kit.env.DB;
  const seq = `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${ROWS - 1})`;
  await run(
    db,
    `${seq} INSERT INTO scans (${columns.join(', ')})
     SELECT ${copied.join(', ')} FROM scans s CROSS JOIN seq WHERE s.id = ?`,
    [scanId],
  );
  await run(
    db,
    `${seq} INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     SELECT printf('clone-event-%04d', n), e.org_id, e.pass_id, e.mode, e.kind, e.device, e.actor_type,
       e.actor_id, json_set(e.data, '$.scanId', printf('clone-%04d', n), '$.authority.scanAt',
         (SELECT at + n FROM scans WHERE id = ?)), e.at + n
     FROM pass_events e CROSS JOIN seq WHERE json_extract(e.data, '$.scanId') = ?`,
    [scanId, scanId],
  );
}

describe('export over a large template manifest', () => {
  it('reads each manifest once across pages and never repeats it per row', async () => {
    const templateId = await kit.scanTemplate('Large manifest card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId, { memberName: PUBLIC });
    const scan = async () => {
      kit.clock.advance(1000);
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      expect(response.status).toBe(200);
      return (await response.json()) as ScanOutcome;
    };
    expect(await scan()).toMatchObject({ kind: 'ok' });
    // A refusal that names the pass: its recorded facts do not mention its own scan id, so it copies.
    const repeat = await scan();
    expect(repeat).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    if (!repeat.scanId) throw new Error('A recorded heads-up must have an id.');
    await withoutTrigger(kit.env.DB, 'template_versions_immutable', () =>
      run(
        kit.env.DB,
        "UPDATE template_versions SET manifest = json_set(manifest, '$.padding', ?) WHERE template_id = ?",
        ['x'.repeat(MANIFEST_PADDING), templateId],
      ),
    );
    const stored = await first<{ size: number }>(
      kit.env.DB,
      'SELECT max(length(manifest)) AS size FROM template_versions WHERE template_id = ?',
      [templateId],
    );
    expect(stored?.size).toBeGreaterThan(MANIFEST_PADDING);
    await clones(repeat.scanId);

    const real = kit.env.DB;
    let manifestReads = 0;
    let pages = 0;
    kit.env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (/AS \(VALUES \(\?, \?, \?\)/.test(sql)) manifestReads++; // sql-shape
            if (sql.includes(RACE_HISTORY_PAGE)) pages++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let text: string;
    try {
      const response = await get(exportPath());
      expect(response.status).toBe(200);
      text = await response.text();
    } finally {
      kit.env.DB = real;
    }
    const lines = text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    // The ok scan, the heads-up and its 999 copies. Each copy's policy was evaluated from the
    // manifest (the template name shows only then); a copy's title hash names another scan, so
    // its pass title stays hidden.
    expect(lines).toHaveLength(ROWS + 2);
    expect(lines.filter((line) => line.includes('Large manifest card'))).toHaveLength(ROWS + 1);
    expect(lines.filter((line) => line.includes(PUBLIC))).toHaveLength(2);
    expect(pages).toBe(2);
    // The manifest is an immutable row read by key: once, not once per row or per page.
    expect(manifestReads).toBe(1);
    // A row carries its keys, never the manifest: the export is far below D1's result cap.
    expect(text.length).toBeLessThan(MANIFEST_PADDING * 20);
  });
});
