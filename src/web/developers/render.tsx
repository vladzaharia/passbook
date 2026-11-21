/**
 * The portal as files: every page's HTML, its markdown twin, llms.txt and the sitemap. Loaded by
 * tools/build-developers.ts through Vite's runner (the pages are the SPA's own React and kit
 * pieces, rendered once at build); nothing here ships to the browser.
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEV_COPY } from '../../shared/copy/developers.ts';
import { LOGS_COPY, STATUS_COPY } from '../../shared/copy/developers-ops.ts';
import { QS_COPY } from '../../shared/copy/developers-quickstart.ts';
import { NOT_FOUND_FILE, PATHS, twin } from '../../shared/developers.ts';
import { runFile, runFileUrl, runIndex } from './console/run-spec.ts';
import type { GuideInputs } from './guide/load.ts';
import { guideMarkdown } from './guide/markdown.ts';
import { resolveGuide } from './guide/model.ts';
import { GuidesIndex, GuideView } from './guide/view.tsx';
import { atomFeed } from './model/changelog.ts';
import { operations } from './model/dates.ts';
import {
  guidesIndexMarkdown,
  homeMarkdown,
  llmsTxt,
  pageMarkdown,
  pagePath,
} from './model/markdown.ts';
import {
  appTwins,
  changelogMarkdown,
  errorMarkdown,
  errorsIndexMarkdown,
  protocolsMarkdown,
  quickstartMarkdown,
  referenceIndexMarkdown,
  webhooksMarkdown,
} from './model/twins.ts';
import type { OutFile, Site } from './model/types.ts';
import { ChangelogView } from './pages/changelog.tsx';
import { ConsoleView } from './pages/console.tsx';
import { HomeView } from './pages/home.tsx';
import { type NavKey, Shell, SideNav } from './pages/layout.tsx';
import { LogsView } from './pages/logs.tsx';
import {
  ErrorEntryView,
  ErrorsIndex,
  ProtocolsView,
  ReferenceIndex,
  WebhooksView,
} from './pages/more.tsx';
import { NotFoundView } from './pages/not-found.tsx';
import { ResourceView } from './pages/resource.tsx';
import { StatusView } from './pages/status.tsx';
import type { BlueprintPreviews } from './playground/model.ts';
import { PlaygroundPage } from './playground/page.tsx';
import { QuickstartSide, QuickstartView } from './quickstart/page.tsx';
import { type Doc, document, fileOf, opIndex } from './render-doc.ts';

const html = (node: ReactElement) => renderToStaticMarkup(node);

export function renderSite(
  site: Site,
  origin: string,
  assets: string,
  guideInputs: GuideInputs = { docs: [], examples: [] },
  previews?: BlueprintPreviews,
): OutFile[] {
  const out: OutFile[] = [];
  const base = `${DEV_COPY.brand} · PassBook`;
  const add = (doc: Doc, dir = false) => {
    out.push({ file: fileOf(doc.url, dir), body: document(doc, origin, assets), url: doc.url });
    if (doc.twin !== undefined) out.push({ file: twin(doc.url), body: doc.twin });
  };
  const side = (current?: Site['pages'][number], ops = false) => (
    <SideNav site={site} current={current} ops={ops} />
  );
  const page = (
    url: string,
    title: string,
    description: string,
    active: NavKey | undefined,
    child: ReactElement,
    o: { side?: ReactElement; dir?: boolean; head?: string; md?: string } = {},
  ) =>
    add(
      {
        url,
        title: `${title} · ${base}`,
        description,
        head: o.head,
        twin: o.md,
        body: html(
          <Shell site={site} active={active} side={o.side}>
            {child}
          </Shell>,
        ),
      },
      o.dir,
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
    { side: side(), dir: true, md: referenceIndexMarkdown(site) },
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
    { side: side(), md: protocolsMarkdown(site) },
  );
  page(
    PATHS.errors,
    'Errors',
    'Error codes and their fixes.',
    'reference',
    <ErrorsIndex site={site} />,
    { side: side(), dir: true, md: errorsIndexMarkdown(site) },
  );
  for (const e of site.errors)
    page(
      `${PATHS.errors}/${e.code}`,
      e.code,
      e.fix || e.title,
      'reference',
      <ErrorEntryView entry={e} />,
      { side: side(), md: errorMarkdown(e) },
    );
  // Wide, no docs grid: the tester needs two columns.
  add({
    url: PATHS.webhooks,
    title: `Webhooks · ${base}`,
    description: 'Capture signed webhooks in your sandbox, verify them and replay them.',
    twin: webhooksMarkdown(site),
    body: html(
      <Shell site={site} active="webhooks" bare>
        <WebhooksView site={site} />
      </Shell>,
    ),
  });
  page(
    PATHS.changelog,
    'Changelog',
    'Changes to the API.',
    undefined,
    <ChangelogView site={site} />,
    {
      head: `<link rel="alternate" type="application/atom+xml" title="PassBook API changelog" href="${PATHS.changelogFeed}">`,
      md: changelogMarkdown(site),
    },
  );
  out.push({ file: PATHS.changelogFeed, body: atomFeed(site, origin) });
  add({
    url: PATHS.playground,
    title: `${DEV_COPY.slots.playground.title} · ${base}`,
    description: 'Edit a pass and watch Apple, Google, Samsung and paper change.',
    twin: appTwins.playground(),
    body: html(<PlaygroundPage site={site} previews={previews} />),
  });
  page(PATHS.console, DEV_COPY.console.title, DEV_COPY.console.line, 'reference', <ConsoleView />, {
    md: appTwins.console(),
  });
  // What the Run island reads: per page the operations it can run, and one index for the console.
  for (const p of site.pages)
    out.push({
      file: runFileUrl(p.slug),
      body: JSON.stringify(
        runFile(
          site.baseUrl || origin,
          p.ops.map((o) => o.run),
        ),
      ),
    });
  out.push({ file: runFileUrl('index'), body: JSON.stringify(runIndex(site)) });
  page(PATHS.logs, LOGS_COPY.title, LOGS_COPY.lede, 'logs', <LogsView />, { md: appTwins.logs() });
  page(PATHS.status, STATUS_COPY.title, STATUS_COPY.lede, undefined, <StatusView />, {
    md: appTwins.status(),
  });
  out.push({ file: PATHS.logsOps, body: JSON.stringify(opIndex(site)) });
  page(PATHS.quickstart, QS_COPY.title, QS_COPY.lede, 'quickstart', <QuickstartView />, {
    side: <QuickstartSide />,
    md: quickstartMarkdown(),
  });
  const guides = guideInputs.docs.map(({ doc }) => resolveGuide(doc, site, guideInputs.examples));
  page(
    PATHS.guides,
    DEV_COPY.slots.guides.title,
    DEV_COPY.slots.guides.line,
    'guides',
    <GuidesIndex guides={guides} />,
    { dir: true, md: guidesIndexMarkdown(guides) },
  );
  for (const g of guides) {
    const markdown = guideMarkdown(g, guideInputs.examples, site.baseUrl || origin);
    add({
      url: g.url,
      title: `${g.meta.title} · Guides · ${base}`,
      description: g.meta.line,
      body: html(
        <Shell site={site} active="guides">
          <GuideView guide={g} examples={guideInputs.examples} markdown={markdown} />
        </Shell>,
      ),
      md: true,
    });
    out.push({ file: twin(g.url), body: markdown });
  }

  out.push({ file: PATHS.llms, body: llmsTxt(site, guides) });
  // Not a route: the Worker serves it, with a 404, for a page that does not exist.
  out.push({
    file: NOT_FOUND_FILE,
    body: document(
      {
        url: PATHS.home,
        title: `${DEV_COPY.notFound.title} · ${base}`,
        description: DEV_COPY.notFound.line,
        body: html(
          <Shell site={site}>
            <NotFoundView />
          </Shell>,
        ),
      },
      origin,
      assets,
    ).replace(/<link rel="canonical"[^>]*>/, ''),
  });
  return out;
}

export function sitemap(origin: string, urls: string[]): string {
  const rows = urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows}</urlset>\n`;
}
