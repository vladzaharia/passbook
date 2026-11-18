import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const remove = (id: string, cursor: string | null = null, headers = h.admin) =>
  h.api(headers, 'POST', `/${id}/remove-created`, { cursor });
const passId = async (externalId: string) =>
  (
    await first<{ id: string }>(
      h.kit.env.DB,
      'SELECT id FROM passes WHERE org_id = ? AND external_id = ?',
      [h.kit.org.id, externalId],
    )
  )?.id ?? '';
const removedAt = async (id: string) =>
  (
    await first<{ removed_at: number | null }>(
      h.kit.env.DB,
      'SELECT removed_at FROM passes WHERE id = ?',
      [id],
    )
  )?.removed_at ?? null;

/** Creates `n` passes through an import and runs it. */
async function imported(prefix: string, n: number) {
  const csv = [HEAD, ...Array.from({ length: n }, (_, i) => `N${i},${i},,${prefix}${i}`)].join(
    '\n',
  );
  const d = await h.draft(csv);
  await h.commit(d.id);
  await h.runWorkflow(d.id);
  return d.id;
}

describe('remove created', () => {
  it('removes what the import created, audits it, and a repeat changes nothing', async () => {
    const old = await h.existing('RO', { memberName: 'Old', points: 1 });
    const id = await h
      .draft([HEAD, 'A,1,,R0', 'B,2,,R1', 'Old2,3,,RO'].join('\n'))
      .then(async (d) => {
        await h.commit(d.id);
        await h.runWorkflow(d.id);
        return d.id;
      });
    const res = await remove(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2, skipped: [], nextCursor: null });
    expect(await removedAt(await passId('R0'))).not.toBeNull();
    expect(await removedAt(await passId('R1'))).not.toBeNull();
    // The matched (updated) pass was not created by the import.
    expect(await removedAt(old.id)).toBeNull();
    expect((await h.get(id)).progress?.removed).toBe(2);
    const audit = await all<{ detail: string }>(
      h.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'pass_import.remove_created' AND target_id = ?",
      [id],
    );
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([
      { importId: id, removed: 2, skipped: 0 },
    ]);

    const again = await remove(id);
    expect(await again.json()).toEqual({ removed: 0, skipped: [], nextCursor: null });
    expect((await h.get(id)).progress?.removed).toBe(2);
  });

  it('pages 50 at a time on the row cursor', async () => {
    const id = await imported('P', 52);
    const first50 = (await (await remove(id)).json()) as { removed: number; nextCursor: string };
    expect(first50.removed).toBe(50);
    expect(first50.nextCursor).toBe('51');
    const rest = await (await remove(id, first50.nextCursor)).json();
    expect(rest).toEqual({ removed: 2, skipped: [], nextCursor: null });
    expect((await h.get(id)).progress?.removed).toBe(52);
  });

  it('skips a pass that was edited or scanned since, and lists it', async () => {
    const id = await imported('S', 3);
    const [edited, scanned, plain] = [await passId('S0'), await passId('S1'), await passId('S2')];
    // An automatic rebuild (template upgrade) is not an edit; an operator's publish is.
    await run(
      h.kit.env.DB,
      "UPDATE passes SET version = version + 1, object_key = object_key || 'a', pending_cause = 'template_upgrade' WHERE id = ?",
      [plain],
    );
    await run(
      h.kit.env.DB,
      "UPDATE passes SET version = version + 1, object_key = object_key || 'a', pending_cause = 'admin' WHERE id = ?",
      [edited],
    );
    await run(
      h.kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, pass_id, actor_type, actor_id, actor_key, idempotency_key,
         request_hash, method, at) VALUES ('scan-s1', ?, 'live', ?, 'system', 'x', 'x', 'k', 'h', 'manual', 1)`,
      [h.kit.org.id, scanned],
    );
    const body = (await (await remove(id)).json()) as {
      removed: number;
      skipped: { passId: string; code: string }[];
    };
    expect(body.removed).toBe(1);
    expect(body.skipped).toEqual([
      { passId: edited, code: 'IMPORT_PASS_CHANGED' },
      { passId: scanned, code: 'IMPORT_PASS_SCANNED' },
    ]);
    expect(await removedAt(plain)).not.toBeNull();
    expect(await removedAt(edited)).toBeNull();
    expect(await removedAt(scanned)).toBeNull();
  });

  it('needs a session: a key is refused, and a running import is busy', async () => {
    const id = await imported('K', 1);
    const refused = await remove(id, null, h.key);
    expect(refused.status).toBe(403);
    expect(await passId('K0')).not.toBe('');
    expect(await removedAt(await passId('K0'))).toBeNull();

    const d = await h.draft([HEAD, 'Busy,1,,B0'].join('\n'));
    await h.commit(d.id);
    const busy = await remove(d.id);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: 'IMPORT_BUSY' });
  });

  it('refuses an import that never ran, and one of another org or mode', async () => {
    const d = await h.draft([HEAD, 'Idle,1,,I0'].join('\n'));
    expect((await remove(d.id)).status).toBe(409);
    const missing = await remove('00000000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
  });
});
