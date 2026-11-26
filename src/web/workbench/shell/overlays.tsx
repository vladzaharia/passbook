import { Keyboard } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { DropdownMenuItem } from '../../ui/dropdown-menu.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { WorkbenchMark } from './mark.tsx';
import type { WorkbenchNavProps } from './nav.tsx';
import { WorkbenchPalette } from './palette.tsx';
import { ShortcutsSheet } from './shortcuts-sheet.tsx';
import { NavColumn } from './sidebar.tsx';

export interface ShellOverlaysProps {
  navOpen: boolean;
  onNavOpen: (open: boolean) => void;
  paletteOpen: boolean;
  onPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  onShortcutsOpen: (open: boolean) => void;
  home: string;
  nav: Omit<WorkbenchNavProps, 'onNavigate'>;
  signedOutNext: string | null;
  quickstartDone: boolean;
  /** The search, when the bar had no room for it (the origin chip on a phone). */
  sheetTop?: ReactNode;
}

/**
 * Everything the shell opens on demand, in its own chunk (WB_SHELL_BUDGET): the nav sheet below
 * 1024, the ⌘K palette and the shortcuts sheet. The shell loads it on the first open, or when idle.
 */
export function ShellOverlays(props: ShellOverlaysProps) {
  const { navOpen, onNavOpen, home, nav, signedOutNext, quickstartDone, sheetTop } = props;
  return (
    <>
      <Sheet open={navOpen} onOpenChange={onNavOpen}>
        <SheetContent side="left" title={WB_SHELL_COPY.nav} header={<WorkbenchMark to={home} />}>
          {sheetTop}
          <NavColumn
            nav={nav}
            signedOutNext={signedOutNext}
            quickstartDone={quickstartDone}
            inSheet
            onNavigate={() => onNavOpen(false)}
          />
        </SheetContent>
      </Sheet>
      <WorkbenchPalette
        open={props.paletteOpen}
        onOpenChange={props.onPaletteOpen}
        singleKeys={nav.singleKeys}
      />
      <ShortcutsSheet open={props.shortcutsOpen} onOpenChange={props.onShortcutsOpen} />
    </>
  );
}

/** The account menu's Workbench item: the shortcuts sheet, where the single-key switch lives. */
export function ShortcutsItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Keyboard aria-hidden />
      {WB_SHELL_COPY.shortcuts}
    </DropdownMenuItem>
  );
}
