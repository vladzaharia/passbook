import { Menu } from 'lucide-react';
import { type ReactNode, useContext } from 'react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { SEARCH_COPY } from '../../../shared/copy/developers-search.ts';
import { PATHS } from '../../../shared/developers.ts';
import { IconButton } from '../../ui/icon-button.tsx';
import { Menubar, MenubarNav, MenubarSearch, SignInButton } from '../../ui/layout/menubar.tsx';
import { Wordmark } from '../../ui/layout/wordmark.tsx';
import type { Site } from '../model/types.ts';
import { Frame, SideNav } from './nav-tree.tsx';
import { Crumbs, Pager, Toc, ToolsRow } from './toc.tsx';

export const SIGN_IN = '/login?next=%2Fdevelopers';
export type NavKey = (typeof DEV_COPY.nav)[number]['key'];

/** Workbench links to the home's workbench until the bar's menu lands (the h0 hand-off). */
export const NAV_PATH: Record<NavKey, string> = {
  quickstart: PATHS.quickstart,
  guides: PATHS.guides,
  reference: PATHS.reference,
  playground: PATHS.playground,
  workbench: `${PATHS.home}#workbench`,
};

export function TopBar({ active }: { active?: NavKey }) {
  return (
    <Menubar
      width="full"
      start={
        <IconButton
          label={DEV_COPY.menu}
          icon={<Menu aria-hidden="true" />}
          className="dev-menu-btn"
          data-menu-button
          aria-expanded="false"
          aria-controls="dev-menu"
        />
      }
      brand={<Wordmark to={PATHS.home} reload hello={false} sub={DEV_COPY.brand} />}
      nav={
        // The wrapper keeps the nav out of the flex row (display: contents); it shows from 1180 px (dev-layout.css).
        <div className="dev-nav">
          <MenubarNav
            label="Sections"
            items={DEV_COPY.nav.map((n) => ({
              label: n.label,
              href: NAV_PATH[n.key],
              current: n.key === active,
            }))}
          />
        </div>
      }
      search={
        <MenubarSearch
          label={SEARCH_COPY.label}
          hint="⌘K"
          data-search
          aria-keyshortcuts="Meta+K Control+K"
        />
      }
      // The sandbox chip (island) when there is one; nothing otherwise.
      controls={<span data-island="org-chip" />}
      account={
        <span data-island="account">
          <SignInButton>
            <a href={SIGN_IN}>{DEV_COPY.signIn}</a>
          </SignInButton>
        </span>
      }
    />
  );
}

/** "page" only on the page the chip links to; its section otherwise ("true"). */
function chipCurrent(key: NavKey, active: NavKey | undefined, path: string) {
  if (key !== active) return undefined;
  return NAV_PATH[key] === path ? 'page' : 'true';
}

/**
 * The sheet's top, below 1181 px, where the bar's sections are not on screen: the five sections,
 * then Sandbox and Spaces (empty in the prerender, filled for a signed-in reader by
 * shell/menu-sheet.ts); signed out, the sheet ends the block with Sign in.
 */
function SheetTop({ active, path }: { active?: NavKey; path: string }) {
  return (
    <div className="menu-only stack">
      <div className="menu-sections">
        {DEV_COPY.nav.map((n) => (
          <a key={n.key} href={NAV_PATH[n.key]} aria-current={chipCurrent(n.key, active, path)}>
            {n.label}
          </a>
        ))}
      </div>
      <div className="menu-sandbox stack" data-menu-sandbox hidden />
      <div className="menu-spaces stack" data-menu-spaces hidden />
      <a className="menu-signin" href={SIGN_IN} data-menu-signin>
        {DEV_COPY.sheet.signIn}
      </a>
    </div>
  );
}

export function Footer({ site }: { site: Site }) {
  const latest = site.changelog[0];
  return (
    <footer className="foot">
      <span className="foot-links">
        <a href={PATHS.changelog}>
          {DEV_COPY.footer.changelog}
          {latest ? <span className="pill accent">{DEV_COPY.footer.whatsNew}</span> : null}
        </a>
        {site.versions[0] ? (
          <a href={`${PATHS.changelog}#version-${site.versions[0].date}`}>
            <span className="pill neutral mono">{site.versions[0].date}</span>
          </a>
        ) : null}
        <a href={PATHS.status}>{DEV_COPY.footer.status}</a>
        <a href={PATHS.openapi}>{DEV_COPY.footer.openapi}</a>
        <a href={PATHS.llms}>{DEV_COPY.footer.llms}</a>
      </span>
    </footer>
  );
}

/**
 * One frame for every page. Docs pages: the tree, the content, "On this page". `app` pages (console,
 * logs) keep the full width with no tree from 1181 px; `bare` pages (home and the tools that lay
 * themselves out) are the bar, their own content and the footer. Below 1181 px the tree is the sheet.
 */
export function Shell({
  site,
  active,
  children,
  app,
  bare,
}: {
  site: Site;
  active?: NavKey;
  children: ReactNode;
  /** A tool with its own full-width column. */
  app?: boolean;
  /** Home and the tools that lay themselves out: no docs grid. */
  bare?: boolean;
}) {
  const f = useContext(Frame);
  const hasToc = (f.toc?.length ?? 0) >= 2;
  const cls = ['docs', app ? 'no-side app' : '', hasToc ? 'has-toc' : ''].filter(Boolean).join(' ');
  const around = (
    <>
      {f.tools ? <ToolsRow path={f.path} /> : null}
      {f.crumbs ? <Crumbs items={f.crumbs} /> : null}
    </>
  );
  return (
    <>
      <a className="skip" href="#main">
        {DEV_COPY.skip}
      </a>
      <TopBar active={active} />
      {bare ? (
        <>
          <SideNav site={site} drawer top={<SheetTop active={active} path={f.path} />} />
          <main id="main">
            {around}
            {children}
          </main>
        </>
      ) : (
        <div className={cls}>
          <SideNav site={site} drawer={app} top={<SheetTop active={active} path={f.path} />} />
          <main id="main" className="main">
            {around}
            {children}
            {f.pager ? <Pager {...f.pager} /> : null}
          </main>
          {hasToc && f.toc ? <Toc items={f.toc} /> : null}
        </div>
      )}
      <Footer site={site} />
    </>
  );
}
