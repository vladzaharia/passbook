import { z } from 'zod';
import { createRouter, register } from '../../platform/openapi.ts';
import { requestTheme } from '../../ssr/head.ts';
import { hostedPage } from '../../ssr/hosted.ts';

/** The page a phone opens when it reads a tag in the background. Static: no lookup, no counter. */
export const tagPageRoutes = createRouter();

register(
  tagPageRoutes,
  'nfc',
  {
    method: 'get',
    path: '/{slug}',
    summary: 'Tag landing page (server-rendered HTML)',
    params: z.object({ slug: z.string() }),
  },
  (c) =>
    new Response(
      hostedPage({
        nonce: c.var.nonce,
        theme: requestTheme(c),
        title: 'PassBook tag',
        art: 'confirm',
        lede: 'Hold this tag to a PassBook scanner.',
        body: '',
      }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'x-robots-tag': 'noindex, nofollow',
        },
      },
    ),
);
