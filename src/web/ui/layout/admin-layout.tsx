import { Outlet } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import { useState } from 'react';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { Button } from '../button.tsx';
import { IconButton } from '../icon-button.tsx';
import { Sheet, SheetContent } from '../sheet.tsx';
import { OrgFilter } from './org-filter.tsx';
import { AdminPalette } from './palette.tsx';
import { SidebarNav } from './sidebar.tsx';
import { ThemeToggle } from './theme-toggle.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

export function AdminLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface-raised lg:flex">
        <div className="flex h-14 items-center px-4">
          <Wordmark to="/admin" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <SidebarNav />
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-surface-page px-3 sm:px-4">
          <div className="lg:hidden">
            <IconButton label="Menu" icon={<Menu aria-hidden />} onClick={() => setNavOpen(true)} />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mr-auto shrink-0 justify-start gap-2 text-fg-muted sm:w-64"
            iconStart={<Search aria-hidden />}
            onClick={() => setPaletteOpen(true)}
          >
            <span className="sr-only sm:not-sr-only sm:truncate">Search</span>
            <kbd className="ml-auto hidden rounded-sm border border-border px-1.5 font-mono text-xs sm:inline">
              ⌘K
            </kbd>
          </Button>
          <OrgFilter />
          <ThemeToggle />
          <UserMenu />
        </header>
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6"
        >
          <Outlet />
        </main>
      </div>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" title="Navigation">
          <SidebarNav onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
      <AdminPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
