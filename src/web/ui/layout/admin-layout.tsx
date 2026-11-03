import { Outlet } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { COARSE_ONLY, useMediaQuery } from '../../lib/media.ts';
import { PaletteContext } from '../../lib/palette.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { useThemeScope } from '../../lib/theme.tsx';
import { Button } from '../button.tsx';
import { IconButton } from '../icon-button.tsx';
import { OfflineBanner } from '../offline-banner.tsx';
import { Sheet, SheetContent } from '../sheet.tsx';
import { AdminPalette } from './palette.tsx';
import { ScopeSwitcher } from './scope-switcher.tsx';
import { SidebarNav } from './sidebar.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

/** "⌘K" on Apple platforms (iPadOS reports a Mac), "Ctrl K" elsewhere. */
export function shortcutHint(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? '⌘K' : 'Ctrl K';
}

export function AdminLayout() {
  useThemeScope();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const touchOnly = useMediaQuery(COARSE_ONLY);
  const palette = useMemo(() => ({ open: () => setPaletteOpen(true) }), []);
  return (
    <PaletteContext.Provider value={palette}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
        {/* The column paints the sidebar background full page height; the inner aside stays sticky. */}
        <div className="hidden border-r border-border bg-surface-raised lg:block">
          <aside className="sticky top-0 flex h-dvh flex-col pl-[env(safe-area-inset-left)]">
            <div className="flex h-14 shrink-0 items-center px-4">
              <Wordmark to="/admin" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <SidebarNav />
            </div>
          </aside>
        </div>
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b border-border bg-surface-page px-safe pt-[env(safe-area-inset-top)] [--wl-gutter:0.75rem] sm:[--wl-gutter:1rem]">
            <div className="lg:hidden">
              <IconButton
                label="Menu"
                icon={<Menu aria-hidden />}
                onClick={() => setNavOpen(true)}
              />
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
            <ScopeSwitcher />
            <UserMenu admin />
          </header>
          <OfflineBanner className="lg:left-60" />
          <main
            id={MAIN_ID}
            tabIndex={-1}
            className="mx-auto w-full max-w-7xl flex-1 px-safe py-6 sm:[--wl-gutter:1.5rem]"
          >
            <Outlet />
          </main>
        </div>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent
            side="left"
            title="Navigation"
            header={<Wordmark to="/admin" hello={false} />}
          >
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>
        <AdminPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </PaletteContext.Provider>
  );
}
