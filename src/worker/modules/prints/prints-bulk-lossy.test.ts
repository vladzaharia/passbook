import { describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handlePrintsBulk } from './jobs.ts';
import { pdfKit } from './pdf-test-fixtures.ts';

// The fallback reports replaced text through its callback; the job must record it in the status.
vi.mock('./pdf-fallback.ts', () => ({
  fallbackPdf: async (_sheets: unknown, onLossy?: () => void) => {
    onLossy?.();
    return new Uint8Array([37, 80, 68, 70]);
  },
}));

describe('bulk status engine and lossy text', () => {
  it('records the engine and that the fallback replaced characters', async () => {
    const { kit, api, printPass } = await pdfKit();
    const pass = await printPass();
    const res = await api('POST', '/passes/bulk-print', { ids: [pass.id], orgId: kit.org.id });
    const started = (await res.json()) as { jobId: string };
    const sent = (kit.queue.sent as { kind: string }[]).find((m) => m.kind === 'prints.bulk');
    await handlePrintsBulk(sent as never, jobCtxOf(kit));
    const status = await api('GET', `/passes/bulk-print/${started.jobId}?orgId=${kit.org.id}`);
    expect(await status.json()).toMatchObject({ state: 'ready', engine: 'fallback', lossy: true });
  });
});
