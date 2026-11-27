import { createContext, type ReactNode, useContext } from 'react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { wbHref } from '../../../shared/workbench.ts';
import { groupByStep } from '../guide/group.ts';
import { opPath, pagePath } from '../model/markdown.ts';
import type { ResourcePage, Site } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';
import { type Crumb, type PagerLinks, TOOL_PATH, type TocItem } from './toc.tsx';

export interface NavGuide {
  id: string;
  title: string;
  url: string;
}

/** What one page tells the frame: where it is, and what sits around its content. Set by the renderer. */
export interface FrameData {
  guides: readonly NavGuide[];
  /** The page's own URL: the tree lights the link that matches it. */
  path: string;
  /** The resource whose operations the tree lists. */
  resource?: ResourcePage;
  crumbs?: readonly Crumb[];
  pager?: PagerLinks;
  /** The page's sections for "On this page"; the column shows from two entries. */
  toc?: readonly TocItem[];
}

export const Frame = createContext<FrameData>({ guides: [], path: '' });

function Item({
  href,
  path,
  ancestor,
  children,
}: {
  href: string;
  path: string;
  /** The page is inside this one: lit, but not "the page". */
  ancestor?: boolean;
  children: ReactNode;
}) {
  const current = href === path ? 'page' : ancestor ? 'true' : undefined;
  return (
    <a href={href} aria-current={current}>
      {children}
    </a>
  );
}

const navLabel = (key: (typeof DEV_COPY.nav)[number]['key']) =>
  DEV_COPY.nav.find((n) => n.key === key)?.label;

const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * The one left tree, on every page: the rail from 1181 px on docs pages, the sheet below that.
 * Guides and Reference fold; the one holding the page is open.
 */
export function SideNav({
  site,
  drawer,
  top,
}: {
  site: Site;
  drawer?: boolean;
  /** The sheet's own top: Sandbox, Spaces, Sign in. */
  top?: ReactNode;
}) {
  const { guides, path, resource } = useContext(Frame);
  const c = DEV_COPY.frame;
  return (
    <nav
      className={drawer ? 'sidenav drawer-only' : 'sidenav'}
      id="dev-menu"
      aria-label={c.docs}
      data-nav
    >
      {top}
      <div className="stack">
        <h4>{c.getStarted}</h4>
        <Item href={wbHref('quickstart')} path={path}>
          {navLabel('quickstart')}
        </Item>
        <Item href={wbHref('design')} path={path}>
          {navLabel('playground')}
        </Item>
      </div>
      <details className="navg" open={within(path, PATHS.guides)}>
        <summary>{DEV_COPY.guides.title}</summary>
        <Item href={PATHS.guides} path={path}>
          {c.allGuides}
        </Item>
        {groupByStep(guides, (g) => g.id).map(({ step, items }) => (
          <div key={step.id} className="stack">
            <h5>{step.label}</h5>
            {items.map((g) => (
              <Item key={g.id} href={g.url} path={path}>
                {g.title}
              </Item>
            ))}
          </div>
        ))}
      </details>
      <details className="navg" open={within(path, PATHS.reference)}>
        <summary>{DEV_COPY.reference.title}</summary>
        <Item href={PATHS.reference} path={path}>
          {c.overview}
        </Item>
        {site.groups.map((g) => (
          <div key={g.label} className="stack">
            <h5>{g.label}</h5>
            {g.pages.map((p) => (
              <div key={p.slug} className="stack">
                <Item href={pagePath(p)} path={path} ancestor={p === resource}>
                  {p.label}
                </Item>
                {p === resource ? (
                  <div className="stack subnav">
                    {p.ops.map((o) => (
                      <Item key={o.anchor} href={opPath(p, o)} path={path}>
                        <MethodPill method={o.method} />
                        <span>{o.title}</span>
                      </Item>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </details>
      <div className="stack">
        <Item href={PATHS.errors} path={path} ancestor={within(path, PATHS.errors)}>
          {DEV_COPY.reference.errors}
        </Item>
      </div>
      <div className="stack">
        <h4>{c.workbench}</h4>
        {DEV_COPY.workbench.map((w) => (
          <Item key={w.key} href={TOOL_PATH[w.key]} path={path}>
            {w.label}
          </Item>
        ))}
      </div>
      <div className="stack">
        <h4>{c.more}</h4>
        <Item href={PATHS.changelog} path={path}>
          {DEV_COPY.footer.changelog}
        </Item>
        <Item href={PATHS.status} path={path}>
          {DEV_COPY.footer.status}
        </Item>
        <Item href={PATHS.protocols} path={path}>
          {c.protocols}
        </Item>
        <a href={PATHS.openapi}>{DEV_COPY.footer.openapi}</a>
        <a href={PATHS.llms}>{DEV_COPY.footer.llms}</a>
      </div>
    </nav>
  );
}
