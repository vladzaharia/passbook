import { bump } from '../../platform/counters.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PdfEngine } from './pdf-store.ts';

const MINUTE = 60_000;
/** New browser launches per minute across the platform: well under Browser Run's paid rate (3 a second). */
export const BROWSER_LAUNCHES_PER_MINUTE = 20;
/** Browser Run gets this long to launch and print before the fallback draws the ticket. */
const BROWSER_TIMEOUT_MS = 25_000;

/** Prints the document with Browser Run (@cloudflare/puppeteer): A4, Letter or half per `@page`, backgrounds on. */
export async function browserPdf(binding: Env['BROWSER'], html: string): Promise<Uint8Array> {
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(binding as never, { keep_alive: 60_000 });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: BROWSER_TIMEOUT_MS });
    await page.emulateMediaType('print');
    return new Uint8Array(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close();
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
        return { bytes: await browser(binding, job.html), engine: 'browser' };
      } catch (error) {
        ctx.log.error('prints.pdf_fallback', { code: 'PRINT_PDF_BROWSER_FAILED', error });
      }
  } else ctx.log.info('prints.pdf_fallback', { code: 'PRINT_PDF_NO_BROWSER' });
  return { bytes: await job.fallback(), engine: 'fallback' };
}
