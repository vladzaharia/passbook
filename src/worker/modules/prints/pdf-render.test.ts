import { describe, expect, it } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { BROWSER_LAUNCHES_PER_MINUTE, renderPdf } from './pdf-render.ts';
import { pdfKit } from './pdf-test-fixtures.ts';

const FROM_BROWSER = new TextEncoder().encode('%PDF-browser');
const FROM_FALLBACK = new TextEncoder().encode('%PDF-fallback');

async function setup(bound: boolean) {
  const { kit } = await pdfKit();
  const logs: { code?: string }[] = [];
  const sink = (_event: string, data?: { code?: string }) => void logs.push(data ?? {});
  const log = { debug: sink, info: sink, warn: sink, error: sink } as never;
  const base = jobCtxOf(kit);
  const ctx = {
    ...base,
    log,
    env: { ...base.env, ...(bound ? { BROWSER: {} as never } : {}) },
  };
  const calls = { browser: 0, fallback: 0 };
  const job = (whenBusy: 'retry' | 'fallback' = 'fallback') => ({
    html: '<p>x</p>',
    whenBusy,
    fallback: async () => {
      calls.fallback++;
      return FROM_FALLBACK;
    },
  });
  const browser = async () => {
    calls.browser++;
    return FROM_BROWSER;
  };
  return { ctx, logs, calls, job, browser };
}

describe('renderPdf', () => {
  it('uses Browser Run when it is bound', async () => {
    const { ctx, calls, job, browser } = await setup(true);
    expect(await renderPdf(ctx, job(), browser)).toEqual({
      bytes: FROM_BROWSER,
      engine: 'browser',
    });
    expect(calls).toEqual({ browser: 1, fallback: 0 });
  });

  it('falls back to pdf-lib with a stable code when the browser fails', async () => {
    const { ctx, logs, calls, job } = await setup(true);
    const failing = async () => {
      throw new Error('launch failed');
    };
    expect(await renderPdf(ctx, job(), failing)).toEqual({
      bytes: FROM_FALLBACK,
      engine: 'fallback',
    });
    expect(calls.fallback).toBe(1);
    expect(logs.map((l) => l.code)).toContain('PRINT_PDF_BROWSER_FAILED');
  });

  it('falls back without a binding', async () => {
    const { ctx, logs, calls, job, browser } = await setup(false);
    expect((await renderPdf(ctx, job(), browser)).engine).toBe('fallback');
    expect(calls).toEqual({ browser: 0, fallback: 1 });
    expect(logs.map((l) => l.code)).toContain('PRINT_PDF_NO_BROWSER');
  });

  it('throttles launches per minute: a single ticket falls back, a bulk job asks to retry', async () => {
    const { ctx, logs, calls, job, browser } = await setup(true);
    // Earlier tests of the file share the minute's counter, so run until the limit bites.
    let engine = 'browser';
    for (let i = 0; i <= BROWSER_LAUNCHES_PER_MINUTE && engine === 'browser'; i++)
      engine = (await renderPdf(ctx, job(), browser)).engine;
    expect(engine).toBe('fallback');
    expect(calls.browser).toBeLessThanOrEqual(BROWSER_LAUNCHES_PER_MINUTE);
    const launched = calls.browser;
    expect(logs.map((l) => l.code)).toContain('PRINT_PDF_RATE_LIMITED');
    await expect(renderPdf(ctx, job('retry'), browser)).rejects.toMatchObject({
      code: 'PRINT_PDF_THROTTLED',
    });
    expect(calls.browser).toBe(launched);
  });
});
