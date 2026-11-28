import { Link } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { WB_SHELL_COPY, wbLabel } from '@/shared/copy/workbench-shell.ts';
import { PATHS } from '@/shared/developers.ts';
import { wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { Kbd } from '../../ui/kbd.tsx';
import { shortcutHint } from '../../ui/layout/menubar.tsx';
import { adminLink } from '../host/tool-host.tsx';
import { ContextSwitcher } from './context-switcher.tsx';
import { WorkbenchNav, type WorkbenchNavProps } from './nav.tsx';
import { useWbShell } from './shell-context.ts';

// Signed out only, so its buddy and button load with it (WB_SHELL_BUDGET).
const SignInCard = lazy(() => import('./moments.tsx').then((m) => ({ default: m.SignInCard })));

const FOOT_LINK =
  'flex min-h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong max-lg:min-h-11 pointer-coarse:min-h-11';

/**
 * The navigation column: the context switcher, the grouped nav, then the foot (Go live or Open in
 * admin, Quickstart once done, ⌘K and ?, and Docs on phones). The sidebar from 1024 and the nav
 * sheet below draw this one component.
 */
export function NavColumn({
  nav,
  signedOutNext,
  quickstartDone,
  inSheet = false,
  onNavigate,
}: {
  nav: Omit<WorkbenchNavProps, 'onNavigate'>;
  signedOutNext: string | null;
  quickstartDone: boolean;
  inSheet?: boolean;
  onNavigate?: () => void;
}) {
  const { context, contexts, tool, openPalette, openShortcuts } = useWbShell();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {context ? (
        <div className="shrink-0 px-3 pt-3 pb-1">
          <ContextSwitcher
            context={context}
            contexts={contexts}
            tool={tool}
            onNavigate={onNavigate}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkbenchNav {...nav} onNavigate={onNavigate} />
        {signedOutNext ? (
          <Suspense fallback={null}>
            <SignInCard next={signedOutNext} />
          </Suspense>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-t border-border px-3 py-2.5">
        {context?.kind === 'sandbox' ? (
          <a href={`${PATHS.guides}/go-live`} className={FOOT_LINK}>
            {WB_SHELL_COPY.goLive}
            <ArrowUpRight aria-hidden className="ml-auto size-4" />
          </a>
        ) : context ? (
          <a href={adminLink(context.orgId)} className={FOOT_LINK}>
            {WB_SHELL_COPY.openInAdmin}
            <ArrowUpRight aria-hidden className="ml-auto size-4" />
          </a>
        ) : null}
        {context && quickstartDone && context.kind === 'sandbox' ? (
          <Link to={wbPath(context.orgId, 'quickstart')} onClick={onNavigate} className={FOOT_LINK}>
            {wbLabel('quickstart')}
            <Check aria-hidden className="ml-auto size-4 text-success" />
          </Link>
        ) : null}
        {inSheet ? (
          <a href={PATHS.home} className={cn(FOOT_LINK, 'sm:hidden')}>
            <BookOpen aria-hidden className="size-4" />
            {WB_SHELL_COPY.docs}
          </a>
        ) : null}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              openPalette();
            }}
            className={cn(FOOT_LINK, 'flex-1')}
          >
            <Kbd className="text-[0.6875rem]">{shortcutHint()}</Kbd>
            {WB_SHELL_COPY.jump}
          </button>
          <button
            type="button"
            aria-label={WB_SHELL_COPY.shortcuts}
            onClick={() => {
              onNavigate?.();
              openShortcuts();
            }}
            className={cn(FOOT_LINK, 'w-8 justify-center px-0 pointer-coarse:hidden')}
          >
            <Kbd className="border-0 text-xs">?</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
