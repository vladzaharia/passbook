import { DEVELOPERS_INDEXABLE, PATHS, twin } from '../../shared/developers.ts';
import { escapeHtml } from '../../shared/html.ts';
import { HEAD_HTML } from '../../worker/ssr/head.ts';
import type { Site } from './model/types.ts';

export interface Doc {
  url: string;
  title: string;
  description: string;
  body: string;
  /** Pages with a twin name it. */
  md?: boolean;
  /** The twin's text: written next to the page as its `.md`. */
  twin?: string;
  /** Extra `<link>`s for the head. */
  head?: string;
}

/** The text face, fetched with the page: a swap after first paint moved the hero's lines (font-display: swap). */
const PRELOAD_FONT =
  '<link rel="preload" as="font" type="font/woff2" href="/fonts/rubik-var-latin.woff2" crossorigin>';

const ROBOTS = DEVELOPERS_INDEXABLE ? '' : '<meta name="robots" content="noindex, nofollow">';

export function document(doc: Doc, origin: string, assets: string): string {
  const url = `${origin}${doc.url}`;
  const md =
    doc.md || doc.twin !== undefined
      ? `<link rel="alternate" type="text/markdown" href="${twin(doc.url)}">`
      : '';
  return (
    '<!doctype html><html lang="en" data-theme-pref="system"><head>' +
    `${HEAD_HTML}${PRELOAD_FONT}${ROBOTS}<title>${escapeHtml(doc.title)}</title>` +
    `<meta name="description" content="${escapeHtml(doc.description)}">` +
    `<link rel="canonical" href="${url}">${md}${doc.head ?? ''}` +
    `<link rel="alternate" type="application/json" href="${PATHS.openapi}">` +
    `<meta property="og:site_name" content="PassBook Developers"><meta property="og:title" content="${escapeHtml(doc.title)}">` +
    `<meta property="og:url" content="${url}"><script src="/theme-init.js"></script>${assets}` +
    `</head><body>${doc.body}</body></html>`
  );
}

/** `METHOD /api/v1/path/{id}` to operationId, for the request log's "Open in builder" (the console takes an operation id). */
export const opIndex = (site: Site): Record<string, string> =>
  Object.fromEntries(
    site.pages.flatMap((p) =>
      p.ops.map((o) => [`${o.method.toUpperCase()} ${o.path}`, o.operationId]),
    ),
  );

/** `/developers/reference/passes` is `developers/reference/passes.html`; a directory page is `index.html`. */
export const fileOf = (url: string, dir: boolean) => (dir ? `${url}/index.html` : `${url}.html`);
