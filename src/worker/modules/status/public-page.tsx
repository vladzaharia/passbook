import { renderToStaticMarkup } from 'react-dom/server';
import { STATUS_SLOT, StatusBody } from '../../../web/developers/pages/status.tsx';
import type { ServiceContext } from '../../platform/service-context.ts';
import { publicStatus } from './public.ts';

/**
 * The prerendered status page with its slot filled from the live data. A failed read leaves the page up with a
 * one-line "unavailable" instead of an error, since a status page that fails when things fail helps nobody.
 */
export async function statusHtml(ctx: ServiceContext, shell: string): Promise<string> {
  const status = await publicStatus(ctx).catch((error) => {
    ctx.log.warn('status.public_failed', { code: 'STATUS_PUBLIC_FAILED', error });
    return null;
  });
  // A function replacement keeps `$&`, `$'` and `$` + backtick in a note literal.
  return shell.replace(STATUS_SLOT, () => renderToStaticMarkup(<StatusBody status={status} />));
}
