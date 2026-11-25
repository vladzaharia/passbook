/** What the renderer hands the frame for a page: crumbs, Prev/Next, the TOC kind, the open resource. */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEV_COPY, DEV_GUIDES } from '../../shared/copy/developers.ts';
import { PATHS } from '../../shared/developers.ts';
import { groupByStep } from './guide/group.ts';
import type { Guide } from './guide/model.ts';
import { opPath, pagePath } from './model/markdown.ts';
import type { OpView, ResourcePage, Site } from './model/types.ts';
import { type NavKey, Shell } from './pages/layout.tsx';
import { Frame, type FrameData, type NavGuide } from './pages/nav-tree.tsx';
import { type Crumb, type PagerLinks, type TocKind, withToc } from './pages/toc.tsx';

export interface FrameOpts {
  /** A tool with its own full-width column (console, logs). */
  app?: boolean;
  /** Home and the tools that lay themselves out. */
  bare?: boolean;
  resource?: ResourcePage;
  crumbs?: readonly Crumb[];
  pager?: PagerLinks;
  /** The page gets "On this page", built from the headings of this kind. */
  toc?: TocKind;
  tools?: boolean;
}

const home: Crumb = { label: DEV_COPY.brand, href: PATHS.home };
const reference: Crumb = { label: DEV_COPY.reference.title, href: PATHS.reference };

export const crumbs = {
  guide: (title: string): Crumb[] => [
    home,
    { label: DEV_COPY.guides.title, href: PATHS.guides },
    { label: title },
  ],
  resource: (p: ResourcePage): Crumb[] => [home, reference, { label: p.label }],
  op: (p: ResourcePage, o: OpView): Crumb[] => [
    home,
    reference,
    { label: p.label, href: pagePath(p) },
    { label: o.title },
  ],
  errors: (code?: string): Crumb[] => [
    home,
    code
      ? { label: DEV_COPY.reference.errors, href: PATHS.errors }
      : { label: DEV_COPY.reference.errors },
    ...(code ? [{ label: code }] : []),
  ],
};

/** Guides in the order the tree lists them: by step, then the copy's order. */
function orderedGuides(guides: readonly Guide[]): Guide[] {
  return groupByStep(guides, (g) => g.meta.id).flatMap((g) => g.items);
}

export function guidePager(guides: readonly Guide[], id: string): PagerLinks {
  const all = orderedGuides(guides);
  const i = all.findIndex((g) => g.meta.id === id);
  const link = (g?: Guide) => (g ? { title: g.meta.title, href: g.url } : undefined);
  return { prev: link(all[i - 1]), next: link(all[i + 1]) };
}

export function opPager(p: ResourcePage, op: OpView): PagerLinks {
  const i = p.ops.indexOf(op);
  const link = (o?: OpView) => (o ? { title: o.title, href: opPath(p, o) } : undefined);
  return { prev: link(p.ops[i - 1]), next: link(p.ops[i + 1]) };
}

export function navGuides(guides: readonly Guide[]): NavGuide[] {
  const rank = (id: string) => DEV_GUIDES.findIndex((g) => g.id === id);
  return [...guides]
    .sort((a, b) => rank(a.meta.id) - rank(b.meta.id))
    .map((g) => ({ id: g.meta.id, title: g.meta.title, url: g.url }));
}

/** Renders pages with the frame around them: the tree knows the guides, the page knows where it is. */
export function framer(site: Site, guides: readonly NavGuide[]) {
  const data = (path: string, o: FrameOpts): FrameData => ({
    guides,
    path,
    resource: o.resource,
    crumbs: o.crumbs,
    pager: o.pager,
    toc: o.toc !== undefined,
    tools: o.tools,
  });
  const html = (node: ReactElement) => renderToStaticMarkup(node);
  return {
    /** A page that carries its own Shell (the playground): only the context is given. */
    provide: (path: string, node: ReactElement, o: FrameOpts = {}) =>
      html(<Frame.Provider value={data(path, o)}>{node}</Frame.Provider>),
    shell: (path: string, active: NavKey | undefined, child: ReactElement, o: FrameOpts = {}) => {
      const page = html(
        <Frame.Provider value={data(path, o)}>
          <Shell site={site} active={active} app={o.app} bare={o.bare}>
            {child}
          </Shell>
        </Frame.Provider>,
      );
      return o.toc ? withToc(page, o.toc) : page;
    },
  };
}
