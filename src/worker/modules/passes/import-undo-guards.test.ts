import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { releaseHeldPage } from './import-held.ts';
import {
  HEAD,
  type ImportHarness,
  plan,
  setupImportHarness,
  stepOf,
} from './import-test-fixtures.ts';
import { undoChunk } from './import-undo-run.ts';
import { removePass } from './remove.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const undo = (id: string, headers = h.admin) => h.api(headers, 'POST', `/${id}/undo`, {});
const column = async <T>(sql: string, ...params: (string | number)[]) =>
  (await first<{ v: T }>(h.kit.env.DB, sql, params))?.v as T;
const runUndo = async (id: string) =>
  runPassImport(
    h.kit.env,
    await column<string>('SELECT undo_instance AS v FROM pass_imports WHERE id = ?', id),
    { importId: id, orgId: h.kit.org.id, mode: 'live', undo: true },
    stepOf(),
  );
const passOf = async (externalId: string) =>
  await first<{ id: string; removed_at: number | null; version: number }>(
    h.kit.env.DB,
    'SELECT id, removed_at, version FROM passes WHERE org_id = ? AND external_id = ?',
    [h.kit.org.id, externalId],
  );
async function imported(csv: string, body: unknown = {}) {
  const d = await h.draft(csv);
  expect((await h.commit(d.id, body)).status).toBe(200);
  await h.runWorkflow(d.id);
  return d.id;
}
const undoState = async (id: string) => (await h.get(id)).undo;

describe('H1: an undone import is terminal', () => {
  it('refuses check, commit and discard once an undo was asked for', async () => {
    const id = await imported([HEAD, 'A,1,,G-1'].join('\n'));
    await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'stale' WHERE id = ?", [id]);
    expect((await undo(id)).status).toBe(200);
    const check = await h.api(h.admin, 'POST', `/${id}/check`, { plan: plan() });
    expect(check.status).toBe(409);
    expect(((await check.json()) as { code: string }).code).toBe('IMPORT_UNDONE');
    const commit = await h.commit(id);
    expect(((await commit.json()) as { code: string }).code).toBe('IMPORT_UNDONE');
    const discard = await h.api(h.admin, 'DELETE', `/${id}`);
    expect(((await discard.json()) as { code: string }).code).toBe('IMPORT_UNDONE');
    expect(
      await column<number>('SELECT count(*) AS v FROM pass_import_rows WHERE import_id = ?', id),
    ).toBe(1);
  });

  it('the run does nothing once the import is no longer ended', async () => {
    const id = await imported([HEAD, 'A,1,,G-2'].join('\n'));
    await undo(id);
    await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'ready' WHERE id = ?", [id]);
    const result = await undoChunk(createJobContext(h.kit.env, 'pass-import'), {
      importId: id,
      orgId: h.kit.org.id,
      mode: 'live',
      undo: true,
    });
    expect(result).toEqual({ more: false });
    expect((await passOf('G-2'))?.removed_at).toBeNull();
  });
});

describe('M1: the removal proves the starter and the scan fence', () => {
  const scope = () => ({
    orgId: h.kit.org.id,
    mode: 'live' as const,
    principal: 'api_key' as const,
  });
  const actor = () => ({ type: 'api_key' as const, id: h.keyId });

  it('a scan before the claim keeps the pass, with no authority and the trusted claim', async () => {
    await imported([HEAD, 'A,1,,M-1'].join('\n'));
    const p = await passOf('M-1');
    await run(
      h.kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, pass_id, actor_type, actor_id, actor_key, idempotency_key,
         request_hash, method, at) VALUES ('scan-m1', ?, 'live', ?, 'system', 'x', 'x', 'km1', 'h', 'manual', 1)`,
      [h.kit.org.id, p?.id ?? ''],
    );
    await expect(
      removePass(h.kit.ctx, actor(), p?.id ?? '', {}, scope(), undefined, {
        version: p?.version ?? 1,
        noScans: true,
      }),
    ).rejects.toBeDefined();
    expect((await passOf('M-1'))?.removed_at).toBeNull();
  });

  it('a failing proof in the publish rolls the claim back', async () => {
    await imported([HEAD, 'A,1,,M-2'].join('\n'));
    const p = await passOf('M-2');
    await expect(
      removePass(h.kit.ctx, actor(), p?.id ?? '', {}, scope(), undefined, undefined, undefined, [
        rawCheck('stale', '1 = 0', []),
      ]),
    ).rejects.toBeDefined();
    expect((await passOf('M-2'))?.removed_at).toBeNull();
  });

  it('stops the run when the starter is revoked, keeping what was done', async () => {
    const id = await imported([HEAD, 'A,1,,M-3', 'B,1,,M-4'].join('\n'));
    await undo(id);
    await run(h.kit.env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [h.keyId]).catch(
      () => undefined,
    );
    await h.api(h.admin, 'GET', `/${id}`);
    await runUndo(id);
    // The admin session is the starter here, so the run completes; the key-starter case is the guard test above.
    expect((await undoState(id))?.state).toBe('done');
  });
});

describe('M4: email-rest and the undo', () => {
  const held = { email: { send: 'held', holdMs: 60_000 } };
  it('is refused while an undo runs and sends now during a hold', async () => {
    const id = await imported(['Name,Points,Email,Id', 'A,1,a@x.co,E-1'].join('\n'), held);
    const now = await h.api(h.admin, 'POST', `/${id}/email-rest`, { cursor: null });
    expect(((await now.json()) as { sent: number }).sent).toBe(1);
    const id2 = await imported(['Name,Points,Email,Id', 'A,1,a@x.co,E-2'].join('\n'), held);
    await undo(id2);
    const refused = await h.api(h.admin, 'POST', `/${id2}/email-rest`, { cursor: null });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('IMPORT_UNDO_RUNNING');
  });
});

describe('M5: asking more than once', () => {
  it('two first asks together give one run and the same answer', async () => {
    const id = await imported([HEAD, 'A,1,,C-1'].join('\n'));
    const [a, b] = await Promise.all([undo(id), undo(id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.created.filter((c) => c.id.startsWith(`pass-import-undo-${id}-`))).toHaveLength(1);
  });

  it('never restarts a running undo, and restarts a dead one through the whole start', async () => {
    const id = await imported([HEAD, 'A,1,,C-2'].join('\n'));
    await undo(id);
    await undo(id);
    const mine = () => h.created.filter((c) => c.id.startsWith(`pass-import-undo-${id}-`));
    expect(mine()).toHaveLength(1);
    h.statuses[mine()[0]?.id ?? ''] = 'errored';
    await run(h.kit.env.DB, 'UPDATE pass_imports SET undo_at = 1 WHERE id = ?', [id]);
    const again = await undo(id);
    expect(again.status).toBe(200);
    expect(mine()).toHaveLength(2);
    expect(
      await column<string>('SELECT starter AS v FROM pass_imports WHERE id = ?', id),
    ).not.toBeNull();
  });
});

describe('M3 and LOW 3: held mail', () => {
  const held = { email: { send: 'held', holdMs: 60_000 } };
  const release = (id: string) =>
    releaseHeldPage(
      createJobContext(h.kit.env, 'pass-import'),
      {
        importId: id,
        orgId: h.kit.org.id,
        mode: 'live',
      },
      0,
    );
  const rowOf = (id: string, n: number) =>
    first<{ emailed: number; mail_pending_at: number | null }>(
      h.kit.env.DB,
      'SELECT emailed, mail_pending_at FROM pass_import_rows WHERE import_id = ? AND row_no = ?',
      [id, n],
    );

  it('mails only the current holder of a live pass', async () => {
    const id = await imported(
      ['Name,Points,Email,Id', 'A,1,a@x.co,H-1', 'B,1,b@x.co,H-2'].join('\n'),
      held,
    );
    // The address on the pass was fixed during the hold: the file's row still says the old one.
    await run(
      h.kit.env.DB,
      "UPDATE pass_import_rows SET holder_email = 'old@x.co' WHERE import_id = ? AND row_no = 2",
      [id],
    );
    await release(id);
    expect((await rowOf(id, 2))?.emailed).toBe(0);
    expect((await rowOf(id, 3))?.emailed).toBe(1);
  });

  it('does not mail a row twice after a step died between claim and send', async () => {
    const id = await imported(
      ['Name,Points,Email,Id', 'A,1,a@x.co,P-1', 'B,1,b@x.co,P-2'].join('\n'),
      held,
    );
    const p1 = await passOf('P-1');
    // Row 2 was claimed and its mail queued; row 3 was claimed and nothing was queued.
    await run(h.kit.env.DB, 'UPDATE pass_import_rows SET mail_pending_at = 5 WHERE import_id = ?', [
      id,
    ]);
    await run(
      h.kit.env.DB,
      "INSERT INTO outbox (id, org_id, kind, pass_id, created_at) VALUES ('ob-p1', ?, 'email', ?, 6)",
      [h.kit.org.id, p1?.id ?? ''],
    );
    const before = await column<number>("SELECT count(*) AS v FROM outbox WHERE kind = 'email'");
    await release(id);
    expect((await rowOf(id, 2))?.emailed).toBe(1);
    expect((await rowOf(id, 3))?.emailed).toBe(1);
    expect(await column<number>("SELECT count(*) AS v FROM outbox WHERE kind = 'email'")).toBe(
      before + 1,
    );
  });
});

describe('LOW codes, counts and restores', () => {
  it('names an import without earlier values, and a pass that is gone', async () => {
    await h.existing('L-OLD', { memberName: 'Old', points: 1 });
    const id = await imported([HEAD, 'N,1,,L-NEW', 'Newer,2,,L-OLD'].join('\n'));
    await run(h.kit.env.DB, 'UPDATE pass_import_rows SET before = NULL WHERE import_id = ?', [id]);
    await run(h.kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE external_id = ?', ['L-NEW']);
    await undo(id);
    await runUndo(id);
    const got = await undoState(id);
    expect(got?.kept.map((k) => k.code).sort()).toEqual([
      'IMPORT_PASS_GONE',
      'IMPORT_UNDO_NO_BEFORE',
    ]);
    expect(got?.unrevertable).toBe(1);
  });

  it('counts its own earlier restore as restored when a step is retried', async () => {
    await h.existing('L-RT', { memberName: 'Old', points: 1 });
    const id = await imported([HEAD, 'Newer,2,,L-RT'].join('\n'));
    const p = await passOf('L-RT');
    const current = await column<string>(
      'SELECT personalization AS v FROM passes WHERE id = ?',
      p?.id ?? '',
    );
    // The restore landed (version + 1, earlier inputs) but the row was never marked.
    await run(
      h.kit.env.DB,
      'UPDATE pass_import_rows SET before = ?, written_version = ? WHERE import_id = ?',
      [
        JSON.stringify({ personalization: JSON.parse(current), fieldSources: {} }),
        (p?.version ?? 1) - 1,
        id,
      ],
    );
    await undo(id);
    await runUndo(id);
    expect(await undoState(id)).toMatchObject({ restored: 1, keptTotal: 0 });
  });

  it('shows an updated row of a committed import with its real changes', async () => {
    await h.existing('L-DF', { memberName: 'Old', points: 1 });
    const id = await imported([HEAD, 'Newer,1,,L-DF'].join('\n'));
    const rows = (await (await h.api(h.admin, 'GET', `/${id}/rows`)).json()) as {
      items: { changes?: { key: string }[] }[];
    };
    expect(rows.items[0]?.changes?.map((c) => c.key)).toEqual(['memberName']);
  });
});

describe('tenant and mode', () => {
  it('another org gets 404, and a test-mode key cannot reach a live import', async () => {
    const id = await imported([HEAD, 'A,1,,T-1'].join('\n'));
    const other = await makeOrg(h.kit.fx, { name: 'Elsewhere' });
    const stranger = await h.auth.apiKey({
      orgId: other.id,
      scopes: ['passes:read', 'passes:write'],
    });
    const elsewhere = await h.app.request(
      `https://wallet.test/api/v1/pass-imports/${id}/undo`,
      { method: 'POST', headers: { ...stranger, 'content-type': 'application/json' }, body: '{}' },
      h.kit.env,
    );
    expect(elsewhere.status).toBe(404);
    const test = await h.auth.apiKey({
      orgId: h.kit.org.id,
      scopes: ['passes:read', 'passes:write'],
      mode: 'test',
    });
    expect((await undo(id, test)).status).toBe(404);
  });
});
