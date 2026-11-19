import { bump } from '../../platform/counters.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PdfEngine } from './pdf-store.ts';

const MINUTE = 60_000;
/** New browser launches per minute across the platform: well under Browser Run's paid rate (3 a second). */
export const BROWSER_LAUNCHES_PER_MINUTE = 20;
/** The whole browser job (launch, load, print, close) gets this long before the fallback draws the ticket. */
const BROWSER_TOTAL_MS = 40_000;
const BROWSER_LOAD_MS = 20_000;
/** A kept-alive session that outlives a crashed Worker is billed until this passes. */
const KEEP_ALIVE_MS = 10_000;

/** A Browser Run launch refused for rate or concurrency; a bulk job retries these instead of falling back. */
const LIMIT = /\b429\b|rate.?limit|too many|limit exceeded/i;

/**
 * Prints the document with Browser Run (@cloudflare/puppeteer): A4, Letter or half per `@page`,
 * backgrounds on. The page is a sealed document: no script, no network. `onCloseError` hears a failed
 * close, which never discards a PDF already made.
 */
export async function browserPdf(
  binding: Env['BROWSER'],
  html: string,
  onCloseError: (error: unknown) => void = () => {},
  totalMs = BROWSER_TOTAL_MS,
): Promise<Uint8Array> {
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    browser = await puppeteer.launch(binding as never, { keep_alive: KEEP_ALIVE_MS });
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => void request.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: BROWSER_LOAD_MS });
    await page.emulateMediaType('print');
    return new Uint8Array(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  })();
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Browser Run timed out')), totalMs);
  });
  // A race loser must not become an unhandled rejection.
  work.catch(() => {});
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    try {
      await browser?.close();
    } catch (error) {
      onCloseError(error);
    }
  }
}

export interface PdfJob {
  html: string;
  /** The same tickets drawn without a browser. */
  fallback: () => Promise<Uint8Array>;
  /** `retry`: a busy browser throws PRINT_PDF_THROTTLED for the queue to retry; `fallback` draws it at once. */
  whenBusy: 'retry' | 'fallback';
}

/**
 * Browser Run first. An unbound, busy or failing browser falls back to pdf-lib with a stable log
 * code; a bulk job asks to retry when only the rate is the problem.
 */
export async function renderPdf(
  ctx: ServiceContext,
  job: PdfJob,
  browser: typeof browserPdf = browserPdf,
): Promise<{ bytes: Uint8Array; engine: PdfEngine }> {
  const binding = ctx.env.BROWSER;
  if (binding) {
    const now = ctx.clock.now();
    const busy =
      (await bump(ctx.env.DB, 'prints:browser', now - (now % MINUTE))) >
      BROWSER_LAUNCHES_PER_MINUTE;
    if (busy && job.whenBusy === 'retry')
      throw new UnavailableError(
        'PDF rendering is busy. Try again shortly.',
        'PRINT_PDF_THROTTLED',
      );
    if (busy) ctx.log.warn('prints.pdf_fallback', { code: 'PRINT_PDF_RATE_LIMITED' });
    else
      try {
        const bytes = await browser(binding, job.html, (error) =>
          ctx.log.warn('prints.pdf_close_failed', { code: 'PRINT_PDF_CLOSE_FAILED', error }),
        );
        return { bytes, engine: 'browser' };
      } catch (error) {
        if (job.whenBusy === 'retry' && LIMIT.test(String((error as Error)?.message)))
          throw new UnavailableError(
            'PDF rendering is busy. Try again shortly.',
            'PRINT_PDF_THROTTLED',
          );
        ctx.log.error('prints.pdf_fallback', { code: 'PRINT_PDF_BROWSER_FAILED', error });
      }
  } else ctx.log.info('prints.pdf_fallback', { code: 'PRINT_PDF_NO_BROWSER' });
  return { bytes: await job.fallback(), engine: 'fallback' };
}
