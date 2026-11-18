import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bump } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const call = (id: string, cursor: string | null = null, headers = h.admin) =>
  h.api(headers, 'POST', `/${id}/email-rest`, { cursor });
const mails = async () =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      "SELECT count(*) AS n FROM outbox WHERE kind = 'email' AND org_id = ?",
      [h.kit.org.id],
    )
  )?.n ?? 0;
const unmailed = async (id: string) =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND emailed = 0 AND holder_email IS NOT NULL',
      [id],
    )
  )?.n;

/** An import that created `n` passes with an address each, without mail. */
async function imported(prefix: string, n: number) {
  const csv = [
    HEAD,
    ...Array.from({ length: n }, (_, i) => `N${i},${i},${prefix}${i}@x.co,${prefix}${i}`),
  ].join('\n');
  const d = await h.draft(csv);
  await h.commit(d.id);
  await h.runWorkflow(d.id);
  return d.id;
}

describe('email the rest', () => {
  it('queues one mail per created pass, marks the rows, audits, and a repeat mails nobody', async () => {
    const id = await imported('EA', 3);
    expect((await h.get(id)).progress?.notEmailed).toBe(3);
    const before = await mails();
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 3, skipped: 0, nextCursor: null });
    expect(await mails()).toBe(before + 3);
    expect(await unmailed(id)).toBe(0);
    expect((await h.get(id)).progress?.notEmailed).toBe(0);
    const audit = await all<{ detail: string }>(
      h.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'pass_import.email_rest' AND target_id = ?",
      [id],
    );
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ importId: id, sent: 3, skipped: 0 }]);
    expect(audit[0]?.detail).not.toMatch(/@x\.co/);

    const again = await call(id);
    expect(await again.json()).toEqual({ sent: 0, skipped: 0, nextCursor: null });
    expect(await mails()).toBe(before + 3);
  });

  it('mails each holder once when two calls race', async () => {
    const id = await imported('EB', 4);
    const before = await mails();
    const [a, b] = await Promise.all([call(id), call(id)]);
    const sent =
      ((await a.json()) as { sent: number }).sent + ((await b.json()) as { sent: number }).sent;
    expect(sent).toBe(4);
    expect(await mails()).toBe(before + 4);
  });

  it('holds back what the daily cap refuses, gives those rows back, and counts them as skipped', async () => {
    const id = await imported('EC', 3);
    const now = h.kit.clock.now();
    await bump(h.kit.env.DB, `pass-email:live:org:${h.kit.org.id}`, now - (now % 86_400_000), 500);
    const before = await mails();
    const res = await call(id);
    expect(await res.json()).toEqual({ sent: 0, skipped: 3, nextCursor: null });
    expect(await mails()).toBe(before);
    expect(await unmailed(id)).toBe(3);
    expect((await h.get(id)).progress?.notEmailed).toBe(3);
    // Tomorrow's budget: the same rows go out.
    await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-email:%'");
    expect(((await (await call(id)).json()) as { sent: number }).sent).toBe(3);
  });

  it('skips a removed pass and pages on the row cursor', async () => {
    const id = await imported('ED', 3);
    const gone = await first<{ id: string }>(
      h.kit.env.DB,
      "SELECT id FROM passes WHERE external_id = 'ED1' AND org_id = ?",
      [h.kit.org.id],
    );
    await run(h.kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [gone?.id ?? '']);
    expect(await (await call(id)).json()).toEqual({ sent: 2, skipped: 0, nextCursor: null });
  });

  it('needs operate and an import that has run', async () => {
    const d = await h.draft([HEAD, 'Idle,1,i@x.co,EE-1'].join('\n'));
    const early = await call(d.id);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'IMPORT_STATE' });
    expect((await call('00000000-0000-7000-8000-000000000000')).status).toBe(404);
  });
});
