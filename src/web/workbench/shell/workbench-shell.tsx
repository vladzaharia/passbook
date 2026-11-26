import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Keyboard, Menu } from 'lucide-react';
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { PATHS } from '@/shared/developers.ts';
import { WB_HOME, WB_TOOLS, type WbTool, wbPath } from '@/shared/workbench.ts';
import { COARSE_ONLY, useMediaQuery } from '../../lib/media.ts';
import { MAIN_ID, useRouteArrival } from '../../lib/route-focus.tsx';
import { ScopeCrumbContext } from '../../lib/scope-context.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { DropdownMenuItem } from '../../ui/dropdown-menu.tsx';
import { IconButton } from '../../ui/icon-button.tsx';
import { ActivityTray } from '../../ui/layout/activity-tray.tsx';
import { AppShell, type AppShellProps } from '../../ui/layout/app-shell.tsx';
import { MenubarSearch, shortcutHint } from '../../ui/layout/menubar.tsx';
import { UserMenu } from '../../ui/layout/user-menu.tsx';
import { useMineOperations } from '../../ui/operation/store.ts';
import { isTerminal } from '../../ui/operation/types.ts';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { WbContext } from '../host/contexts.ts';
import { useSessionGone } from '../host/session-gone.ts';
import { useWorkbenchSummary } from '../host/summary.ts';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { AnnouncerProvider, useAnnounce } from './announcer.tsx';
import { AreaButton } from './area-button.tsx';
import { firstDanger, navAttention, quickstartDone, useSeenMarks } from './attention.ts';
import { WorkbenchMark } from './mark.tsx';
import { contextFreePath, navGroups } from './nav-model.ts';
import { useOrigin } from './origin.ts';
import { OriginChip } from './origin-chip.tsx';
import { WorkbenchPalette } from './palette.tsx';
import { useSingleKeys } from './prefs.ts';
import { WbShellContext } from './shell-context.ts';
import { ShortcutsSheet } from './shortcuts-sheet.tsx';
import { NavColumn } from './sidebar.tsx';
import { ChordHint, useShellKeys } from './use-shell-keys.tsx';
import './shell.css';

export interface WorkbenchShellProps {
  /** Every context this person may open; empty signed out. */
  contexts: readonly WbContext[];
  /** The context the path names, when it is one of them. */
  context: WbContext | null;
  tool: WbTool | null;
  /** Signed out: where Sign in returns. */
  signedOutNext: string | null;
  children: ReactNode;
}

const NAV_ID = 'wb-nav';
const SKIP =
  'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-on';

/** The route title joins the shell's one announcement queue; focus moves to the h1. */
function RouteArrivals() {
  const announce = useAnnounce();
  useRouteArrival((title) => announce(title));
  return null;
}

/**
 * The Workbench's own chrome (design §1.2), built on the kit: AppShell (the bar, a 15rem sidebar
 * from 1024, the sheet below), Menubar, UserMenu, OperationTray (ActivityTray) and CommandPalette.
 * An org's Test tones the bar as admin's Test does; a sandbox keeps the plain bar.
 */
function Shell({ contexts, context, tool, signedOutNext, children }: WorkbenchShellProps) {
  const navigate = useNavigate();
  const host = useOptionalToolHost();
  const singleKeys = useSingleKeys();
  const touchOnly = useMediaQuery(COARSE_ONLY);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const marks = useSeenMarks(context?.orgId);
  const summary = useWorkbenchSummary(host?.api ?? null, marks);
  const mine = useMineOperations();
  const running = mine.filter((op) => op.orgId === context?.orgId && !isTerminal(op.status)).length;
  const attention = useMemo(
    () => (context ? navAttention(summary.data, running) : {}),
    [context, summary.data, running],
  );
  const done = quickstartDone(summary.data);
  const tools = context?.tools ?? WB_TOOLS;
  const origin = useOrigin();
  const sessionGone = useSessionGone();
  const home = context ? wbPath(context.orgId, 'home') : WB_HOME;
  const go = (t: WbTool) => {
    if (!tools.includes(t)) return;
    void navigate({ to: context ? wbPath(context.orgId, t) : contextFreePath(t) });
  };
  const hint = useShellKeys({ singleKeys, onGo: go, onHelp: () => setShortcutsOpen(true) });
  const shell = useMemo(
    () => ({
      context,
      contexts,
      tool,
      attention,
      openShortcuts: () => setShortcutsOpen(true),
      openPalette: () => setPaletteOpen(true),
    }),
    [context, contexts, tool, attention],
  );
  const crumb = useMemo(
    () => (context ? { label: context.name, to: home } : undefined),
    [context, home],
  );
  const tone = context?.kind === 'org' ? ('test' as const) : undefined;
  const nav = {
    groups: navGroups(tools, done),
    orgId: context?.orgId ?? null,
    current: tool,
    attention,
    known: summary.isSuccess,
    singleKeys,
  };
  const search = (
    <MenubarSearch
      label={WB_SHELL_COPY.search}
      hint={touchOnly ? undefined : shortcutHint()}
      onClick={() => setPaletteOpen(true)}
    />
  );
  const bar: NonNullable<AppShellProps['bar']> = {
    brand: (
      <div className="flex min-w-0 items-center gap-1 lg:hidden">
        <IconButton label="Menu" icon={<Menu aria-hidden />} onClick={() => setNavOpen(true)} />
        {tool ? (
          <AreaButton
            tool={tool}
            context={context}
            attentionIn={firstDanger(attention, tool)}
            onOpen={() => setNavOpen(true)}
          />
        ) : (
          <WorkbenchMark to={home} />
        )}
      </div>
    ),
    nav: (
      <div className="flex min-w-0 items-center gap-2 lg:flex-1">
        {origin ? <OriginChip origin={origin} /> : null}
        <div className="max-lg:hidden lg:[&>button]:w-[26rem]">{search}</div>
      </div>
    ),
    // Below 1024 the search sits at the right; with the origin chip on a phone it moves to the sheet.
    search: <div className={origin ? 'lg:hidden max-sm:hidden' : 'lg:hidden'}>{search}</div>,
    controls: (
      <>
        <a
          href={PATHS.home}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong max-lg:hidden"
        >
          <BookOpen aria-hidden className="size-4" />
          {WB_SHELL_COPY.docs}
        </a>
        <ActivityTray />
      </>
    ),
    tone,
    account: (
      <UserMenu
        extra={
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
            <Keyboard aria-hidden />
            {WB_SHELL_COPY.shortcuts}
          </DropdownMenuItem>
        }
      />
    ),
  };
  const sidebar = (
    <aside className="sticky top-0 flex h-dvh flex-col pl-[env(safe-area-inset-left)]">
      <div
        data-bar-start
        data-tone={tone}
        className="flex h-14 shrink-0 items-center border-b border-border px-4"
      >
        <WorkbenchMark to={home} />
      </div>
      <div id={NAV_ID} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
        <NavColumn nav={nav} signedOutNext={signedOutNext} quickstartDone={done} />
      </div>
    </aside>
  );
  return (
    <WbShellContext.Provider value={shell}>
      <ScopeCrumbContext.Provider value={crumb}>
        <div className="wb-shell">
          <a
            href={`#${NAV_ID}`}
            className={SKIP}
            onClick={(e) => skipToNav(e, () => setNavOpen(true))}
          >
            {WB_SHELL_COPY.skipNav}
          </a>
          <a href={`#${MAIN_ID}`} className={SKIP}>
            {WB_SHELL_COPY.skipTool}
          </a>
          <RouteArrivals />
          <AppShell bar={bar} sidebar={sidebar} width="console" holder={false}>
            {sessionGone ? <SessionGoneBanner /> : null}
            {children}
          </AppShell>
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetContent
              side="left"
              title={WB_SHELL_COPY.nav}
              header={<WorkbenchMark to={home} />}
            >
              {origin ? <div className="px-3 pt-3 sm:hidden">{search}</div> : null}
              <NavColumn
                nav={nav}
                signedOutNext={signedOutNext}
                quickstartDone={done}
                inSheet
                onNavigate={() => setNavOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <WorkbenchPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            singleKeys={singleKeys}
          />
          <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          {hint ? <ChordHint tools={tools} /> : null}
        </div>
      </ScopeCrumbContext.Provider>
    </WbShellContext.Provider>
  );
}

/** "Skip to navigation": the sidebar from 1024; below it, the nav sheet. */
function skipToNav(e: MouseEvent, openSheet: () => void) {
  e.preventDefault();
  const nav = document.getElementById(NAV_ID);
  if (nav && nav.offsetParent !== null) nav.focus();
  else openSheet();
}

/** The session behind the token ended: one banner, the page kept, back to this URL after. */
function SessionGoneBanner() {
  const here = `${location.pathname}${location.search}${location.hash}`;
  return (
    <Callout
      tone="warning"
      title={WB_STATES.sessionExpired.title}
      actionsAside
      className="mb-4"
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={`/login?next=${encodeURIComponent(here)}&reason=expired`}>
            {WB_STATES.sessionExpired.action}
          </a>
        </Button>
      }
    />
  );
}

export function WorkbenchShell(props: WorkbenchShellProps) {
  return (
    <AnnouncerProvider>
      <Shell {...props} />
    </AnnouncerProvider>
  );
}
