import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { SEARCH_COPY } from '../../../shared/copy/developers-search.ts';
import { PATHS } from '../../../shared/developers.ts';
import { IconButton } from '../../ui/icon-button.tsx';
import { Menubar, MenubarNav, MenubarSearch, SignInButton } from '../../ui/layout/menubar.tsx';
import { Wordmark } from '../../ui/layout/wordmark.tsx';
import { pagePath } from '../model/markdown.ts';
import type { ResourcePage, Site } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';

export const SIGN_IN = '/login?next=%2Fdevelopers';
export type NavKey = (typeof DEV_COPY.nav)[number]['key'];

export const NAV_PATH: Record<NavKey, string> = {
  quickstart: PATHS.quickstart,
  guides: PATHS.guides,
  reference: PATHS.reference,
  playground: PATHS.playground,
  webhooks: PATHS.webhooks,
  logs: PATHS.logs,
};

export function TopBar({ active }: { active?: NavKey }) {
  return (
    <Menubar
      width="full"
      start={
        <IconButton
          label={DEV_COPY.menu}
          icon={<Menu aria-hidden="true" />}
          className="min-[901px]:hidden"
          data-menu-button
          aria-expanded="false"
          aria-controls="dev-menu"
        />
      }
      brand={<Wordmark to={PATHS.home} reload hello={false} sub={DEV_COPY.brand} />}
      nav={
        <MenubarNav
          label="Sections"
          items={DEV_COPY.nav.map((n) => ({
            label: n.label,
            href: NAV_PATH[n.key],
            current: n.key === active,
          }))}
        />
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
      controls={<span data-island="org-chip" className="empty:hidden" />}
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

/** Reference nav: groups by job; the open resource lists its operations. */
export function SideNav({
  site,
  current,
  ops,
}: {
  site?: Site;
  current?: ResourcePage;
  ops?: boolean;
}) {
  return (
    <nav
      className={site ? 'sidenav' : 'sidenav drawer-only'}
      id="dev-menu"
      aria-label={site ? 'Reference' : 'Menu'}
    >
      <div className="menu-only stack">
        <h4>Developers</h4>
        {DEV_COPY.nav.map((n) => (
          <a key={n.key} href={NAV_PATH[n.key]}>
            {n.label}
          </a>
        ))}
      </div>
      {site?.groups.map((g) => (
        <div key={g.label} className="stack">
          <h4>{g.label}</h4>
          {g.pages.map((p) => (
            <div key={p.slug} className="stack">
              <a href={pagePath(p)} aria-current={p === current && !ops ? 'page' : undefined}>
                {p.label}
              </a>
              {p === current && ops ? (
                <div className="stack subnav">
                  {p.ops.map((o) => (
                    <a key={o.anchor} href={`#${o.anchor}`}>
                      <span>{o.title}</span>
                      <MethodPill method={o.method} />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {site ? (
        <div className="stack">
          <h4>More</h4>
          <a href={PATHS.errors}>Errors</a>
          <a href={PATHS.protocols}>Protocols</a>
        </div>
      ) : null}
    </nav>
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
          <a
            className="pill neutral mono"
            href={`${PATHS.changelog}#version-${site.versions[0].date}`}
          >
            {site.versions[0].date}
          </a>
        ) : null}
        <a href={PATHS.status}>{DEV_COPY.footer.status}</a>
        <a href={PATHS.openapi}>{DEV_COPY.footer.openapi}</a>
        <a href={PATHS.llms}>{DEV_COPY.footer.llms}</a>
      </span>
    </footer>
  );
}

export function Shell({
  site,
  active,
  children,
  side,
  bare,
}: {
  site: Site;
  active?: NavKey;
  children: ReactNode;
  side?: ReactNode;
  /** The home page: full-width sections, no docs grid. */
  bare?: boolean;
}) {
  return (
    <>
      <a className="skip" href="#main">
        {DEV_COPY.skip}
      </a>
      <TopBar active={active} />
      {bare ? (
        <>
          <SideNav />
          <main id="main">{children}</main>
        </>
      ) : (
        <div className={side ? 'docs' : 'docs no-side'}>
          {side ?? <SideNav />}
          <main id="main" className="main">
            {children}
          </main>
        </div>
      )}
      <Footer site={site} />
    </>
  );
}
