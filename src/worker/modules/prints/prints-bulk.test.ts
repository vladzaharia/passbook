import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { PRINT_BULK_MAX } from '../../../shared/contracts/prints.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { voidPass } from '../passes/service.ts';
import { handlePrintsBulk } from './jobs.ts';
import { dropPrintPdfs } from './pdf-drop.ts';
import { readPdf } from './pdf-read.ts';
import { bulkKey } from './pdf-store.ts';
import { FORBIDDEN, pdfKit, pdfText } from './pdf-test-fixtures.ts';

type Started = {
  jobId: string;
  count: number;
  skipped: { id: string; code: string; reason?: string }[];
};

async function setup() {
  const k = await pdfKit();
  const start = (ids: string[], orgId = k.kit.org.id, headers = k.kit.auth.admin()) =>
    k.api('POST', '/passes/bulk-print', { ids, orgId }, headers);
  const jobs = () =>
    (k.kit.queue.sent as { kind: string; jobId: string; passIds: string[] }[]).filter(
      (m) => m.kind === 'prints.bulk',
    );
  return { ...k, start, jobs };
}

describe('bulk print', () => {
  it('prints the passes that have no active print, queues one job and renders one combined PDF', async () => {
    const { kit, api, printPass, mint, start, jobs } = await setup();
    const a = await printPass();
    const b = await printPass('b@example.com');
    const off = await kit.datedPass({}, 'off@example.com');
    const existing = await mint(a.id);
    const res = await start([a.id, b.id, off.id]);
    expect(res.status).toBe(202);
    const started = (await res.json()) as Started;
    expect(started.count).toBe(2);
    expect(started.skipped).toEqual([
      { id: off.id, code: 'PRINTING_OFF', reason: expect.stringMatching(/^Paper is off for .+/) },
    ]);
    // The existing print stays (not replaced), the new pass got one.
    const prints = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM pass_prints WHERE status = 'active' ORDER BY pass_id",
    );
    expect(prints.map((p) => p.id)).toContain(existing.id);
    expect(prints).toHaveLength(2);
    const [job] = jobs();
    expect(job?.jobId).toBe(started.jobId);
    expect(job?.passIds.sort()).toEqual([a.id, b.id].sort());

    const status = () =>
      api('GET', `/passes/bulk-print/${started.jobId}?orgId=${kit.org.id}`).then((r) => r.json());
    expect(await status()).toEqual({ state: 'pending', count: 2, skipped: 0, lossy: false });
    expect(
      (await api('GET', `/passes/bulk-print/${started.jobId}/pdf?orgId=${kit.org.id}`)).status,
    ).toBe(404);

    await handlePrintsBulk(job as never, jobCtxOf(kit));
    expect(await status()).toEqual({
      state: 'ready',
      count: 2,
      skipped: 0,
      lossy: false,
      engine: 'pdf-lib',
    });
    const pdf = await api('GET', `/passes/bulk-print/${started.jobId}/pdf?orgId=${kit.org.id}`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('cache-control')).toBe('private, no-store');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const text = await pdfText(bytes);
    const pages = await readPdf(bytes);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.lines).toContain('Spring Concert');
    expect(text).not.toContain(FORBIDDEN);
    // Running the job again changes nothing.
    await handlePrintsBulk(job as never, jobCtxOf(kit));
    expect(await kit.env.BUCKET.head(bulkKey(kit.org.id, started.jobId, 'pdf'))).not.toBeNull();
  });

  it('caps the selection and says so', async () => {
    const { printPass, start } = await setup();
    const one = await printPass();
    const ids = [one.id, ...Array.from({ length: PRINT_BULK_MAX }, (_, i) => `x${i}`)];
    expect(ids.length).toBe(PRINT_BULK_MAX + 1);
    expect((await start(ids)).status).toBe(422);
  });

  it('is 404 for a pass of another org, and for another org as the target', async () => {
    const { kit, printPass, start } = await setup();
    const pass = await printPass();
    const other = await makeOrg(kit.fx);
    const foreign = await start([pass.id], other.id);
    expect([403, 404]).toContain(foreign.status);
    const missing = await start(['nope']);
    expect(missing.status).toBe(404);
    expect((await start([pass.id], kit.org.id, kit.auth.user())).status).toBeGreaterThanOrEqual(
      403,
    );
  });

  it('keeps a job private to its org and session', async () => {
    const { kit, api, printPass, start } = await setup();
    const pass = await printPass();
    const started = (await (await start([pass.id])).json()) as Started;
    const other = await makeOrg(kit.fx);
    const peek = await api('GET', `/passes/bulk-print/${started.jobId}?orgId=${other.id}`);
    expect([403, 404]).toContain(peek.status);
    const key = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const asKey = await api(
      'POST',
      '/passes/bulk-print',
      { ids: [pass.id], orgId: kit.org.id },
      key,
    );
    expect(asKey.status).toBeGreaterThanOrEqual(401);
  });

  it('answers nothing-to-print without a job when no pass can print', async () => {
    const { kit, start, jobs } = await setup();
    const off = await kit.datedPass({}, 'off@example.com');
    const started = (await (await start([off.id])).json()) as Started;
    expect(started).toMatchObject({ jobId: '', count: 0 });
    expect(jobs()).toHaveLength(0);
  });
});

describe('bulk PDF access and deletion', () => {
  async function ready() {
    const k = await setup();
    const pass = await k.printPass();
    const started = (await (await k.start([pass.id])).json()) as Started;
    await handlePrintsBulk(k.jobs()[0] as never, jobCtxOf(k.kit));
    const path = `/passes/bulk-print/${started.jobId}/pdf?orgId=${k.kit.org.id}`;
    return { ...k, pass, started, path };
  }

  it('serves only the requesting user, in the org and mode, for 24 hours', async () => {
    const { kit, api, path, started } = await ready();
    expect((await api('GET', path)).status).toBe(200);
    const testMode = await api('GET', path, undefined, {
      ...kit.auth.admin(),
      'x-passbook-mode': 'test',
    });
    expect(testMode.status).toBe(404);
    const key = bulkKey(kit.org.id, started.jobId, 'json');
    const stored = (await (await kit.env.BUCKET.get(key))?.json()) as Record<string, unknown>;
    await kit.env.BUCKET.put(key, JSON.stringify({ ...stored, userId: 'someone-else' }));
    expect((await api('GET', path)).status).toBe(404);
    await kit.env.BUCKET.put(
      key,
      JSON.stringify({ ...stored, at: jobCtxOf(kit).clock.now() - 25 * 3_600_000 }),
    );
    expect((await api('GET', path)).status).toBe(404);
  });

  it('is gone once a print of the pass is voided', async () => {
    const { kit, api, pass, path, started } = await ready();
    const [print] = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM pass_prints WHERE pass_id = ?',
      [pass.id],
    );
    expect((await api('POST', `/passes/${pass.id}/prints/${print?.id}/void`)).status).toBe(200);
    expect((await api('GET', path)).status).toBe(404);
    expect(await kit.env.BUCKET.head(bulkKey(kit.org.id, started.jobId, 'pdf'))).toBeNull();
  });

  it('is gone once the pass is voided', async () => {
    const { kit, api, pass, path } = await ready();
    expect((await api('GET', path)).status).toBe(200);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect((await api('GET', path)).status).toBe(404);
  });

  it('is gone once the pass is purged', async () => {
    const { kit, api, pass, path } = await ready();
    expect((await api('GET', path)).status).toBe(200);
    await dropPrintPdfs(jobCtxOf(kit), { orgId: kit.org.id, id: pass.id });
    expect((await api('GET', path)).status).toBe(404);
  });
});

describe('bulk job outcomes', () => {
  it('logs and counts a pass whose print ended before the render', async () => {
    const { kit, api, printPass, start, jobs } = await setup();
    const a = await printPass();
    const b = await printPass('b@example.com');
    const started = (await (await start([a.id, b.id])).json()) as Started;
    const [print] = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM pass_prints WHERE pass_id = ?',
      [b.id],
    );
    const voided = await api('POST', `/passes/${b.id}/prints/${print?.id}/void`);
    expect(voided.status).toBe(200);
    const logged: { code?: string }[] = [];
    const sink = (_e: string, d?: { code?: string }) => void logged.push(d ?? {});
    const base = jobCtxOf(kit);
    await handlePrintsBulk(jobs()[0] as never, {
      ...base,
      log: { debug: sink, info: sink, warn: sink, error: sink } as never,
    });
    expect(logged.map((l) => l.code)).toContain('PRINT_BULK_PASS_SKIPPED');
    const status = await (
      await api('GET', `/passes/bulk-print/${started.jobId}?orgId=${kit.org.id}`)
    ).json();
    expect(status).toMatchObject({ state: 'ready', count: 1, skipped: 1 });
  });
});

describe('bulk job race', () => {
  it('deletes the PDF and fails the job when a print is voided while it renders', async () => {
    const { kit, api, printPass, start, jobs } = await setup();
    const a = await printPass();
    const started = (await (await start([a.id])).json()) as Started;
    const [print] = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM pass_prints WHERE pass_id = ?',
      [a.id],
    );
    // The void lands after the job has read the print, as the PDF is being stored.
    const base = jobCtxOf(kit);
    const bucket = kit.env.BUCKET;
    const racing = {
      ...bucket,
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      delete: bucket.delete.bind(bucket),
      put: async (key: string, value: never, options?: never) => {
        const out = await bucket.put(key, value, options);
        if (key.endsWith('.pdf'))
          await run(
            kit.env.DB,
            "UPDATE pass_prints SET status = 'voided', voided_at = 1, void_cause = 'manual' WHERE id = ?",
            [print?.id ?? ''],
          );
        return out;
      },
    } as unknown as R2Bucket;
    await handlePrintsBulk(jobs()[0] as never, { ...base, env: { ...base.env, BUCKET: racing } });
    expect(await bucket.head(bulkKey(kit.org.id, started.jobId, 'pdf'))).toBeNull();
    const status = await (
      await api('GET', `/passes/bulk-print/${started.jobId}?orgId=${kit.org.id}`)
    ).json();
    expect(status).toMatchObject({ state: 'failed', count: 0 });
  });
});
