import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Menu } from 'lucide-react';
import {
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { nowIn, WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { PATHS } from '@/shared/developers.ts';
import { WB_HOME, WB_TOOLS, type WbTool, wbPath } from '@/shared/workbench.ts';
import { COARSE_ONLY, useMediaQuery } from '../../lib/media.ts';
import { MAIN_ID, useRouteArrival } from '../../lib/route-focus.tsx';
import { ScopeCrumbContext } from '../../lib/scope-context.ts';
import { IconButton } from '../../ui/icon-button.tsx';
import { ActivityTray } from '../../ui/layout/activity-tray.tsx';
import { AppShell, type AppShellProps } from '../../ui/layout/app-shell.tsx';
import { MenubarSearch, shortcutHint } from '../../ui/layout/menubar.tsx';
import { UserMenu } from '../../ui/layout/user-menu.tsx';
import { useMineOperations } from '../../ui/operation/store.ts';
import { isTerminal, type Operation } from '../../ui/operation/types.ts';
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
import { useSingleKeys } from './prefs.ts';
import { WbShellContext } from './shell-context.ts';
import { NavColumn } from './sidebar.tsx';
import { ChordHint, useShellKeys } from './use-shell-keys.tsx';
import './shell.css';

// The sheets, the palette and the account menu's item open on demand (WB_SHELL_BUDGET).
const overlays = () => import('./overlays.tsx');
const Overlays = lazy(() => overlays().then((m) => ({ default: m.ShellOverlays })));
const ShortcutsItem = lazy(() => overlays().then((m) => ({ default: m.ShortcutsItem })));
const SessionGoneBanner = lazy(() =>
  import('./moments.tsx').then((m) => ({ default: m.SessionGoneBanner })),
);

export interface WorkbenchShellProps {
  /** Every context this person may open; empty signed out. */
  contexts: readonly WbContext[];
  /** The context the path names, when it is one of them. */
  context: WbContext | null;
  tool: WbTool | null;
  /** Signed out: only Design and Quickstart link, and the bar offers no second Sign in. */
  signedOut: boolean;
  /** Signed out on a public area: where the sidebar's Sign in returns. */
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
function Shell({
  contexts,
  context,
  tool,
  signedOut,
  signedOutNext,
  children,
}: WorkbenchShellProps) {
  const navigate = useNavigate();
  const host = useOptionalToolHost();
  const singleKeys = useSingleKeys();
  const touchOnly = useMediaQuery(COARSE_ONLY);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const marks = useSeenMarks(context?.orgId);
  const summary = useWorkbenchSummary(host?.api ?? null, marks);
  // The tray and the Activity count read one scope: this context's Test operations, never Live ones
  // the same browser started in admin.
  const orgId = context?.orgId;
  const inContext = useCallback(
    (op: Operation) => op.mode === 'test' && op.orgId === orgId,
    [orgId],
  );
  const mine = useMineOperations();
  const running = mine.filter((op) => inContext(op) && !isTerminal(op.status)).length;
  const attention = useMemo(
    () => (context ? navAttention(summary.data, running) : {}),
    [context, summary.data, running],
  );
  const done = quickstartDone(summary.data);
  const announce = useAnnounce();
  const lastContext = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // A context change says so, in the one queue; the first resolved view and a signed-out one do not.
    if (contexts.length === 0) return;
    const before = lastContext.current;
    lastContext.current = orgId ?? null;
    if (before !== undefined && orgId && before !== orgId && context) announce(nowIn(context.name));
  }, [orgId, context, contexts.length, announce]);
  const tools = context?.tools ?? WB_TOOLS;
  const origin = useOrigin();
  const sessionGone = useSessionGone();
  const home = context ? wbPath(context.orgId, 'home') : WB_HOME;
  const go = (t: WbTool) => {
    if (!tools.includes(t)) return;
    void navigate({ to: context ? wbPath(context.orgId, t) : contextFreePath(t) });
  };
  const hint = useShellKeys({
    singleKeys,
    onGo: go,
    onHelp: () => setShortcutsOpen(true),
    onPalette: () => setPaletteOpen((open) => !open),
  });
  // Load the overlays on the first open, or once the page is idle.
  const [overlaysWanted, setOverlaysWanted] = useState(false);
  if (!overlaysWanted && (navOpen || paletteOpen || shortcutsOpen)) setOverlaysWanted(true);
  useEffect(() => {
    if (typeof requestIdleCallback !== 'function') return;
    const id = requestIdleCallback(() => void overlays());
    return () => cancelIdleCallback(id);
  }, []);
  const shell = useMemo(
    () => ({
      context,
      contexts,
      tool,
      attention,
      seenAt: summary.data?.now,
      openShortcuts: () => setShortcutsOpen(true),
      openPalette: () => setPaletteOpen(true),
    }),
    [context, contexts, tool, attention, summary.data?.now],
  );
  const crumb = useMemo(
    () => (context ? { label: context.name, to: home } : undefined),
    [context, home],
  );
  const tone = context?.kind === 'org' ? ('test' as const) : undefined;
  const nav = {
    groups: navGroups(tools, done),
    orgId: context?.orgId ?? null,
    signedOut,
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
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong max-sm:hidden"
        >
          <BookOpen aria-hidden className="size-4" />
          {WB_SHELL_COPY.docs}
        </a>
        {host ? (
          <ActivityTray
            client={host.operations}
            include={inContext}
            allHref={wbPath(host.context.orgId, 'activity')}
          />
        ) : null}
      </>
    ),
    tone,
    // Signed out there is one Sign in per view: the stage state, on Design the sidebar card from 1024
    // and this bar's button below it (the card sits in the closed sheet), on Quickstart its step 1.
    account: signedOut ? (
      signedOutNext ? (
        <div className="lg:hidden">
          <UserMenu />
        </div>
      ) : null
    ) : (
      <UserMenu
        extra={
          <Suspense fallback={null}>
            <ShortcutsItem onSelect={() => setShortcutsOpen(true)} />
          </Suspense>
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
            {sessionGone ? (
              <Suspense fallback={null}>
                <SessionGoneBanner />
              </Suspense>
            ) : null}
            {children}
          </AppShell>
          {overlaysWanted ? (
            <Suspense fallback={null}>
              <Overlays
                navOpen={navOpen}
                onNavOpen={setNavOpen}
                paletteOpen={paletteOpen}
                onPaletteOpen={setPaletteOpen}
                shortcutsOpen={shortcutsOpen}
                onShortcutsOpen={setShortcutsOpen}
                home={home}
                nav={nav}
                signedOutNext={signedOutNext}
                quickstartDone={done}
                sheetTop={origin ? <div className="px-3 pt-3 sm:hidden">{search}</div> : null}
              />
            </Suspense>
          ) : null}
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

export function WorkbenchShell(props: WorkbenchShellProps) {
  return (
    <AnnouncerProvider>
      <Shell {...props} />
    </AnnouncerProvider>
  );
}
