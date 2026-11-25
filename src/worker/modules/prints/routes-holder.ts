import { sameOriginOnly } from '../../platform/csrf.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import { createRouter } from '../../platform/openapi.ts';
import { ASSET_MISSES_PER_MINUTE, gateMisses, rateLimit } from '../../platform/rate-limit.ts';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage } from '../../ssr/pass-page.tsx';
import { PRINT_HEADERS, renderPrintPage } from '../../ssr/print-page.tsx';
import { orgBrandOf } from '../orgs/brand.ts';
import { svc } from '../passes/http.ts';
import { passForToken } from '../public/service.ts';
import { printPageModel } from './page.ts';
import { assertHolderMayPrint } from './paper.ts';
import { PDF_HEADERS, ticketPdf } from './pdf-service.ts';
import { linkWriter } from './repo-write.ts';
import { HOLDER_PRINTS_PER_HOUR, mintPrint, refreshActivePrint, voidPrint } from './service.ts';

/**
 * /p/:token/print: the holder's own print, by bearer link. POSTs only, no pass or page is read here:
 * the first POST mints, `reprint` replaces, `void` ends it. A rotated link or a transfer stops them.
 */
export const holderPrintRoutes = createRouter();
holderPrintRoutes.use('/:token/print', sameOriginOnly);
holderPrintRoutes.use('/:token/print/*', sameOriginOnly);
holderPrintRoutes.use('/:token/print', gateMisses(ASSET_MISSES_PER_MINUTE));
holderPrintRoutes.use('/:token/print/*', gateMisses(ASSET_MISSES_PER_MINUTE));
holderPrintRoutes.use('/:token/print', rateLimit('RL_PUBLIC'));
holderPrintRoutes.use('/:token/print/*', rateLimit('RL_PUBLIC'));

/**
 * An unknown, rotated or malformed link is a plain 404 (passForToken throws it). A template whose
 * paper block says `holder: false` refuses every holder change, a void of a staff print included.
 */
async function holderCall(c: Parameters<typeof svc>[0]) {
  const ctx = svc(c);
  const pass = await passForToken(ctx, c.req.param('token') ?? '');
  await assertHolderMayPrint(ctx, pass);
  return { ctx, pass, caller: { writer: linkWriter(pass), limit: HOLDER_PRINTS_PER_HOUR } };
}

const noStore = { 'cache-control': 'private, no-store' };

/** The page: the active print, or a button that makes one by POST. A GET never mints. */
holderPrintRoutes.get('/:token/print', async (c) => {
  const ctx = svc(c);
  const theme = requestTheme(c);
  const token = c.req.param('token') ?? '';
  try {
    const pass = await passForToken(ctx, token);
    const model = await printPageModel(ctx, pass, 'holder');
    const html = renderPrintPage({
      model,
      audience: 'holder',
      backHref: `/p/${token}`,
      pdfHref: `/p/${token}/print/pdf`,
      assetBase: `/p/${token}/assets/`,
      nonce: c.var.nonce,
      brand: await orgBrandOf(ctx, pass.orgId),
      ...(theme ? { theme } : {}),
    });
    return new Response(html, { headers: PRINT_HEADERS });
  } catch (error) {
    if (error instanceof AppError && error.status === 404)
      return new Response(renderNotFoundPage(c.var.nonce, theme, { replay: false }), {
        status: 404,
        headers: PRINT_HEADERS,
      });
    throw error;
  }
});

holderPrintRoutes.post('/:token/print', async (c) => {
  const call = await holderCall(c);
  const print = await mintPrint(call.ctx, call.caller, call.pass, false);
  return c.json(print, 200, noStore);
});

holderPrintRoutes.post('/:token/print/reprint', async (c) => {
  const call = await holderCall(c);
  return c.json(await mintPrint(call.ctx, call.caller, call.pass, true), 200, noStore);
});

/** The page's Print button: the active print is drawn again, so it matches the pass as it is now. */
holderPrintRoutes.post('/:token/print/drawn', async (c) => {
  const call = await holderCall(c);
  const print = await refreshActivePrint(call.ctx, call.caller.writer, call.pass);
  if (!print) throw new NotFoundError('No active print.', 'PRINT_NOT_FOUND');
  return c.json(print, 200, noStore);
});

holderPrintRoutes.post('/:token/print/void', async (c) => {
  const call = await holderCall(c);
  return c.json(await voidPrint(call.ctx, call.caller, call.pass, 'holder'), 200, noStore);
});

/** The PDF of the holder's active print. A rotated link or a transfer is a 404 before anything is read. */
holderPrintRoutes.get('/:token/print/pdf', async (c) => {
  const ctx = svc(c);
  const pass = await passForToken(ctx, c.req.param('token') ?? '');
  return new Response(await ticketPdf(ctx, pass, 'holder', linkWriter(pass)), {
    headers: PDF_HEADERS,
  });
});
