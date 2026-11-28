import { Outlet } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { COARSE_ONLY, useMediaQuery } from '../../lib/media.ts';
import { useMode } from '../../lib/mode.ts';
import { useAdminScope, useOrgScope } from '../../lib/org-filter.tsx';
import { PaletteContext } from '../../lib/palette.ts';
import { allPath, scopePath } from '../../lib/scope.ts';
import { ScopeCrumbContext } from '../../lib/scope-context.ts';
import { useSession } from '../../lib/session.ts';
import { IconButton } from '../icon-button.tsx';
import { Sheet, SheetContent } from '../sheet.tsx';
import { ActivityTray } from './activity-tray.tsx';
import { AppShell, type AppShellProps } from './app-shell.tsx';
import { BridgeChip } from './bridge-chip.tsx';
import { GraceBanner } from './grace-banner.tsx';
import { MenubarSearch, shortcutHint } from './menubar.tsx';
import { ModeAnnouncer } from './mode-announcer.tsx';
import { ModeSwitch } from './mode-switch.tsx';
import { AdminPalette } from './palette.tsx';
import { ScopeSwitcher } from './scope-switcher.tsx';
import { SidebarNav } from './sidebar.tsx';
import { SidebarFoot } from './sidebar-foot.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

export function AdminLayout({ children }: { children?: ReactNode }) {
  const scope = useAdminScope();
  // The wordmark opens the scope's overview; Live and Test apply in an organization and across organizations.
  // The All scope has no overview: its one page is Passes.
  const home = scope?.kind === 'all' ? allPath('/passes') : scope ? scopePath(scope) : '/admin';
  const org = scope?.kind === 'org';
  const { membership } = useOrgScope();
  const { isAdmin } = useSession();
  const mode = useMode();
  // Only where Live and Test are a choice; a sandbox is always Test, so its bar does not change.
  const switchable = scope?.kind === 'all' || (org && !membership?.testOnly);
  const scopeName =
    scope?.kind === 'all'
      ? 'All organizations'
      : scope?.kind === 'platform'
        ? isAdmin
          ? 'Platform'
          : undefined
        : membership?.orgName;
  const crumb = useMemo(
    () => (scopeName ? { label: scopeName, to: home } : undefined),
    [scopeName, home],
  );
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const touchOnly = useMediaQuery(COARSE_ONLY);
  const palette = useMemo(() => ({ open: () => setPaletteOpen(true) }), []);
  const tone = switchable && mode === 'test' ? ('test' as const) : undefined;
  const sidebar = (
    // The shell's column paints the sidebar background full page height; this stays sticky.
    <aside className="sticky top-0 flex h-dvh flex-col pl-[env(safe-area-inset-left)]">
      {/* The bar's brand row: from lg the mark lives here, level with the bar. */}
      <div
        data-bar-start
        data-tone={tone}
        className="flex h-14 shrink-0 items-center border-b border-border px-4"
      >
        <Wordmark to={home} />
      </div>
      <div className="shrink-0 px-4 py-3">
        <ScopeSwitcher />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SidebarNav />
      </div>
      <SidebarFoot />
    </aside>
  );
  const bar: NonNullable<AppShellProps['bar']> = {
    // Below lg the sidebar is a drawer: its button and the mark open the bar.
    brand: (
      <div className="flex items-center gap-2 lg:hidden">
        <IconButton label="Menu" icon={<Menu aria-hidden />} onClick={() => setNavOpen(true)} />
        <Wordmark to={home} />
      </div>
    ),
    nav: <BridgeChip />,
    search: (
      <MenubarSearch
        label="Search"
        hint={touchOnly ? undefined : shortcutHint()}
        onClick={() => setPaletteOpen(true)}
      />
    ),
    controls: (
      <>
        <ActivityTray />
        {switchable ? <ModeSwitch /> : null}
      </>
    ),
    tone,
    account: <UserMenu />,
  };
  return (
    <PaletteContext.Provider value={palette}>
      <ScopeCrumbContext.Provider value={crumb}>
        <AppShell bar={bar} sidebar={sidebar} width="console" holder={false}>
          {switchable ? <ModeAnnouncer /> : null}
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
            <SidebarFoot />
          </SheetContent>
        </Sheet>
        <AdminPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </ScopeCrumbContext.Provider>
    </PaletteContext.Provider>
  );
}
