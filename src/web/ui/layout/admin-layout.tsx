import { Outlet } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { COARSE_ONLY, useMediaQuery } from '../../lib/media.ts';
import { useAdminScope, useOrgScope } from '../../lib/org-filter.tsx';
import { PaletteContext } from '../../lib/palette.ts';
import { scopePath } from '../../lib/scope.ts';
import { ScopeCrumbContext } from '../../lib/scope-context.ts';
import { useSession } from '../../lib/session.ts';
import { Button } from '../button.tsx';
import { IconButton } from '../icon-button.tsx';
import { Sheet, SheetContent } from '../sheet.tsx';
import { AppShell } from './app-shell.tsx';
import { GraceBanner } from './grace-banner.tsx';
import { ModeBand } from './mode-band.tsx';
import { ModeSwitch } from './mode-switch.tsx';
import { AdminPalette } from './palette.tsx';
import { ScopeSwitcher } from './scope-switcher.tsx';
import { SidebarNav } from './sidebar.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

/** "⌘K" on Apple platforms (iPadOS reports a Mac), "Ctrl K" elsewhere. */
export function shortcutHint(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? '⌘K' : 'Ctrl K';
}

export function AdminLayout({ children }: { children?: ReactNode }) {
  const scope = useAdminScope();
  // The wordmark opens the scope's overview; mode only exists inside an organization.
  const home = scope ? scopePath(scope) : '/admin';
  const org = scope?.kind === 'org';
  const { membership } = useOrgScope();
  const { isAdmin } = useSession();
  const scopeName =
    scope?.kind === 'platform' ? (isAdmin ? 'Platform' : undefined) : membership?.orgName;
  const crumb = useMemo(
    () => (scopeName ? { label: scopeName, to: home } : undefined),
    [scopeName, home],
  );
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const touchOnly = useMediaQuery(COARSE_ONLY);
  const palette = useMemo(() => ({ open: () => setPaletteOpen(true) }), []);
  const sidebar = (
    // The shell's column paints the sidebar background full page height; this stays sticky.
    <aside className="sticky top-0 flex h-dvh flex-col pl-[env(safe-area-inset-left)]">
      <div className="shrink-0 px-4 pb-3 pt-4">
        <Wordmark to={home} />
        <div className="mt-3">
          <ScopeSwitcher />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SidebarNav />
      </div>
    </aside>
  );
  const bar = (
    <>
      <div className="lg:hidden">
        <IconButton label="Menu" icon={<Menu aria-hidden />} onClick={() => setNavOpen(true)} />
      </div>
      <IconButton
        label="Search"
        icon={<Search aria-hidden />}
        onClick={() => setPaletteOpen(true)}
        className="sm:hidden"
      />
      <Button
        variant="outline"
        className="mr-auto hidden shrink-0 justify-start gap-2 px-3 font-normal text-fg-muted sm:inline-flex sm:w-64"
        iconStart={<Search aria-hidden />}
        onClick={() => setPaletteOpen(true)}
      >
        <span className="truncate">Search</span>
        {touchOnly ? null : (
          <kbd className="ml-auto rounded-sm border border-border px-1.5 font-sans text-xs">
            {shortcutHint()}
          </kbd>
        )}
      </Button>
      <span className="mr-auto sm:hidden" />
      {org ? <ModeSwitch /> : null}
      <UserMenu />
    </>
  );
  return (
    <PaletteContext.Provider value={palette}>
      <ScopeCrumbContext.Provider value={crumb}>
        <AppShell
          bar={bar}
          sidebar={sidebar}
          band={org ? <ModeBand /> : null}
          width="console"
          holder={false}
        >
          <GraceBanner />
          {children ?? <Outlet />}
        </AppShell>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent
            side="left"
            title="Navigation"
            header={<Wordmark to={home} hello={false} />}
          >
            <div className="px-5 pb-2">
              <ScopeSwitcher onNavigate={() => setNavOpen(false)} />
            </div>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>
        <AdminPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </ScopeCrumbContext.Provider>
    </PaletteContext.Provider>
  );
}
