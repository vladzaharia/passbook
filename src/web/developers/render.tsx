/**
 * The portal as files: every page's HTML, its markdown twin, llms.txt and the sitemap. Loaded by
 * tools/build-developers.ts through Vite's runner (the pages are the SPA's own React and kit
 * pieces, rendered once at build); nothing here ships to the browser.
 */
import type { ReactElement } from 'react';
import { DEV_COPY } from '../../shared/copy/developers.ts';
import { KEYS_COPY } from '../../shared/copy/developers-keys.ts';
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
  opPageMarkdown,
  opPath,
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
import { KeysView } from './pages/keys.tsx';
import type { NavKey } from './pages/layout.tsx';
import { LogsView } from './pages/logs.tsx';
import {
  ErrorEntryView,
  ErrorsIndex,
  ProtocolsView,
  ReferenceIndex,
  WebhooksView,
} from './pages/more.tsx';
import { NotFoundView } from './pages/not-found.tsx';
import { OperationView } from './pages/operation.tsx';
import { ResourceView } from './pages/resource.tsx';
import { StatusView } from './pages/status.tsx';
import type { BlueprintPreviews } from './playground/model.ts';
import { PlaygroundPage } from './playground/page.tsx';
import { QuickstartView } from './quickstart/page.tsx';
import { type Doc, document, fileOf, opIndex } from './render-doc.ts';
import {
  crumbs,
  type FrameOpts,
  framer,
  guidePager,
  navGuides,
  opPager,
  toc,
} from './render-frame.tsx';

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
  const guides = guideInputs.docs.map(({ doc }) => resolveGuide(doc, site, guideInputs.examples));
  const fr = framer(site, navGuides(guides));
  const page = (
    url: string,
    title: string,
    description: string,
    active: NavKey | undefined,
    child: ReactElement,
    o: FrameOpts & { dir?: boolean; head?: string; md?: string } = {},
  ) =>
    add(
      {
        url,
        title: `${title} · ${base}`,
        description,
        head: o.head,
        twin: o.md,
        body: fr.shell(url, active, child, o),
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
        body: fr.shell(PATHS.home, undefined, <HomeView site={site} />, { bare: true }),
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
    { dir: true, md: referenceIndexMarkdown(site) },
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
          body: fr.shell(url, 'reference', <ResourceView page={p} />, {
            resource: p,
            crumbs: crumbs.resource(p),
          }),
          md: true,
        },
        origin,
        assets,
      ),
    });
    out.push({ file: twin(url), body: pageMarkdown(p, site) });
    for (const op of p.ops) {
      const opUrl = opPath(p, op);
      out.push({
        file: fileOf(opUrl, false),
        url: opUrl,
        body: document(
          {
            url: opUrl,
            title: `${op.title} · ${p.label} · API reference · ${base}`,
            description:
              `${op.method.toUpperCase()} ${op.path}. ${op.description.split('\n')[0] ?? ''}`.trim(),
            body: fr.shell(opUrl, 'reference', <OperationView page={p} op={op} site={site} />, {
              resource: p,
              crumbs: crumbs.op(p, op),
              pager: opPager(p, op),
              toc: toc.op(op),
            }),
            md: true,
          },
          origin,
          assets,
        ),
      });
      out.push({ file: twin(opUrl), body: opPageMarkdown(p, op, site) });
    }
  }
  page(
    PATHS.protocols,
    'Protocols',
    'Apple, scanner and public routes.',
    'reference',
    <ProtocolsView site={site} />,
    { md: protocolsMarkdown(site) },
  );
  page(
    PATHS.errors,
    'Errors',
    'Error codes and their fixes.',
    'reference',
    <ErrorsIndex site={site} />,
    { dir: true, crumbs: crumbs.errors(), toc: toc.errors(site), md: errorsIndexMarkdown(site) },
  );
  for (const e of site.errors)
    page(
      `${PATHS.errors}/${e.code}`,
      e.code,
      e.fix || e.title,
      'reference',
      <ErrorEntryView entry={e} />,
      { crumbs: crumbs.errors(e.code), md: errorMarkdown(e) },
    );
  // Wide, no docs grid: the tester needs two columns.
  add({
    url: PATHS.webhooks,
    title: `Webhooks · ${base}`,
    description: 'Capture signed webhooks in your sandbox, verify them and replay them.',
    twin: webhooksMarkdown(site),
    body: fr.shell(PATHS.webhooks, 'workbench', <WebhooksView site={site} />, {
      bare: true,
      tools: true,
    }),
  });
  page(
    PATHS.changelog,
    'Changelog',
    'Changes to the API.',
    undefined,
    <ChangelogView site={site} />,
    {
      toc: toc.changelog(site),
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
    body: fr.provide(PATHS.playground, <PlaygroundPage site={site} previews={previews} />),
  });
  page(PATHS.console, DEV_COPY.console.title, DEV_COPY.console.line, 'workbench', <ConsoleView />, {
    app: true,
    tools: true,
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
  // The keys island is wide and has no docs grid.
  add({
    url: PATHS.keys,
    title: `${KEYS_COPY.title} · ${base}`,
    description: 'Make, roll and revoke the keys of your sandbox.',
    twin: appTwins.keys(),
    body: fr.shell(PATHS.keys, 'workbench', <KeysView />, { bare: true, tools: true }),
  });
  page(PATHS.logs, LOGS_COPY.title, LOGS_COPY.lede, 'workbench', <LogsView />, {
    app: true,
    tools: true,
    md: appTwins.logs(),
  });
  page(PATHS.status, STATUS_COPY.title, STATUS_COPY.lede, undefined, <StatusView />, {
    md: appTwins.status(),
  });
  out.push({ file: PATHS.logsOps, body: JSON.stringify(opIndex(site)) });
  page(PATHS.quickstart, QS_COPY.title, QS_COPY.lede, 'quickstart', <QuickstartView />, {
    md: quickstartMarkdown(),
  });
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
      body: fr.shell(
        g.url,
        'guides',
        <GuideView guide={g} examples={guideInputs.examples} markdown={markdown} />,
        {
          crumbs: crumbs.guide(g.meta.title),
          pager: guidePager(guides, g.meta.id),
          toc: toc.guide(g),
        },
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
        body: fr.shell('', undefined, <NotFoundView />),
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
