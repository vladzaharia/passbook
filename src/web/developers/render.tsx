/**
 * The portal as files: every page's HTML, its markdown twin, llms.txt and the sitemap. Loaded by
 * tools/build-developers.ts through Vite's runner (the pages are the SPA's own React and kit
 * pieces, rendered once at build); nothing here ships to the browser.
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEV_COPY } from '../../shared/copy/developers.ts';
import { DEVELOPERS_INDEXABLE, PATHS, twin } from '../../shared/developers.ts';
import { escapeHtml } from '../../shared/html.ts';
import { HEAD_HTML } from '../../worker/ssr/head.ts';
import { operations } from './model/dates.ts';
import { homeMarkdown, llmsTxt, pageMarkdown, pagePath } from './model/markdown.ts';
import type { OutFile, Site } from './model/types.ts';
import { HomeView } from './pages/home.tsx';
import { type NavKey, Shell, SideNav } from './pages/layout.tsx';
import {
  ChangelogView,
  ErrorEntryView,
  ErrorsIndex,
  ProtocolsView,
  ReferenceIndex,
  SlotView,
  WebhooksView,
} from './pages/more.tsx';
import { ResourceView } from './pages/resource.tsx';

interface Doc {
  url: string;
  title: string;
  description: string;
  body: string;
  /** Pages with a twin name it; others have none. */
  md?: boolean;
}

const ROBOTS = DEVELOPERS_INDEXABLE ? '' : '<meta name="robots" content="noindex, nofollow">';

function document(doc: Doc, origin: string, assets: string): string {
  const url = `${origin}${doc.url}`;
  const md = doc.md ? `<link rel="alternate" type="text/markdown" href="${twin(doc.url)}">` : '';
  return (
    '<!doctype html><html lang="en" data-theme-pref="system"><head>' +
    `${HEAD_HTML}${ROBOTS}<title>${escapeHtml(doc.title)}</title>` +
    `<meta name="description" content="${escapeHtml(doc.description)}">` +
    `<link rel="canonical" href="${url}">${md}` +
    `<link rel="alternate" type="application/json" href="${PATHS.openapi}">` +
    `<meta property="og:site_name" content="PassBook Developers"><meta property="og:title" content="${escapeHtml(doc.title)}">` +
    `<meta property="og:url" content="${url}"><script src="/theme-init.js"></script>${assets}` +
    `</head><body>${doc.body}</body></html>`
  );
}

const html = (node: ReactElement) => renderToStaticMarkup(node);

/** `/developers/reference/passes` is `developers/reference/passes.html`; a directory page is `index.html`. */
const fileOf = (url: string, dir: boolean) => (dir ? `${url}/index.html` : `${url}.html`);

export function renderSite(site: Site, origin: string, assets: string): OutFile[] {
  const out: OutFile[] = [];
  const base = `${DEV_COPY.brand} · PassBook`;
  const add = (doc: Doc, dir = false) =>
    out.push({ file: fileOf(doc.url, dir), body: document(doc, origin, assets), url: doc.url });
  const side = (current?: Site['pages'][number], ops = false) => (
    <SideNav site={site} current={current} ops={ops} />
  );
  const page = (
    url: string,
    title: string,
    description: string,
    active: NavKey | undefined,
    child: ReactElement,
    withSide?: ReactElement,
    dir = false,
  ) =>
    add(
      {
        url,
        title: `${title} · ${base}`,
        description,
        body: html(
          <Shell site={site} active={active} side={withSide}>
            {child}
          </Shell>,
        ),
      },
      dir,
    );

  // Home is a document of its own: no docs grid.
  out.push({
    file: '/developers/index.html',
    url: PATHS.home,
    body: document(
      {
        url: PATHS.home,
        title: `PassBook ${DEV_COPY.brand}`,
        description: DEV_COPY.home.lede,
        body: html(
          <Shell site={site} bare>
            <HomeView site={site} />
          </Shell>,
        ),
        md: true,
      },
      origin,
      assets,
    ),
  });
  out.push({ file: twin(PATHS.home), body: homeMarkdown(site) });

  page(
    PATHS.reference,
    'API reference',
    DEV_COPY.reference.lede,
    'reference',
    <ReferenceIndex site={site} />,
    side(),
    true,
  );
  for (const p of site.pages) {
    const url = pagePath(p);
    out.push({
      file: fileOf(url, false),
      url,
      body: document(
        {
          url,
          title: `${p.label} · API reference · ${base}`,
          description: `${p.label}, ${operations(p.ops.length)}: ${p.ops
            .slice(0, 3)
            .map((o) => o.title)
            .join(', ')}.`,
          body: html(
            <Shell site={site} active="reference" side={side(p, true)}>
              <ResourceView page={p} site={site} />
            </Shell>,
          ),
          md: true,
        },
        origin,
        assets,
      ),
    });
    out.push({ file: twin(url), body: pageMarkdown(p, site) });
  }
  page(
    PATHS.protocols,
    'Protocols',
    'Apple, scanner and public routes.',
    'reference',
    <ProtocolsView site={site} />,
    side(),
  );
  page(
    PATHS.errors,
    'Errors',
    'Error codes and their fixes.',
    'reference',
    <ErrorsIndex site={site} />,
    side(),
    true,
  );
  for (const e of site.errors)
    page(
      `${PATHS.errors}/${e.code}`,
      e.code,
      e.fix || e.title,
      'reference',
      <ErrorEntryView entry={e} />,
      side(),
    );
  page(
    PATHS.webhooks,
    'Webhooks',
    'Signed webhook events.',
    'webhooks',
    <WebhooksView site={site} />,
  );
  page(
    PATHS.changelog,
    'Changelog',
    'Changes to the API.',
    undefined,
    <ChangelogView site={site} />,
  );
  for (const which of ['quickstart', 'playground', 'guides'] as const)
    page(
      PATHS[which],
      DEV_COPY.slots[which].title,
      DEV_COPY.slots[which].line,
      which,
      <SlotView which={which} />,
    );

  out.push({ file: PATHS.llms, body: llmsTxt(site) });
  return out;
}

export function sitemap(origin: string, urls: string[]): string {
  const rows = urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows}</urlset>\n`;
}
