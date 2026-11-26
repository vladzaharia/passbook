import { Link } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check, KeyRound } from 'lucide-react';
import { POLARIS_ID_COPY } from '@/shared/copy/sign-in.ts';
import { countsFor, WB_AREA, WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { PATHS } from '@/shared/developers.ts';
import { wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { Buddy } from '../../ui/art/index.ts';
import { Button } from '../../ui/button.tsx';
import { shortcutHint } from '../../ui/layout/menubar.tsx';
import { adminLink } from '../host/tool-host.tsx';
import { ContextSwitcher } from './context-switcher.tsx';
import { WorkbenchNav, type WorkbenchNavProps } from './nav.tsx';
import { useWbShell } from './shell-context.ts';

const FOOT_LINK =
  'flex min-h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:min-h-11';

/** Signed out, at the sidebar's foot: the buddy waves over one line and Sign in. */
function SignInCard({ next }: { next: string }) {
  return (
    <div className="relative mx-3 mt-16 mb-3 rounded-lg border border-dashed border-border-strong bg-surface-page px-3.5 pt-3 pb-3.5">
      <div aria-hidden className="absolute -top-px right-4 h-0 w-16">
        <Buddy size="sm" scene="wave" mood="happy" state="login" at="end" />
      </div>
      <p className="mb-2.5 text-sm font-medium text-fg-strong">{WB_STATES.signedOut.title}</p>
      <Button asChild size="sm" iconStart={<KeyRound aria-hidden />} className="w-full">
        <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>{POLARIS_ID_COPY.signIn}</a>
      </Button>
    </div>
  );
}

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
          {inSheet ? (
            <p className="mt-1.5 px-1 text-xs text-fg-muted">{countsFor(context.name)}</p>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkbenchNav {...nav} onNavigate={onNavigate} />
        {signedOutNext ? <SignInCard next={signedOutNext} /> : null}
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
            {WB_AREA.quickstart.label}
            <Check aria-hidden className="ml-auto size-4 text-success" />
          </Link>
        ) : null}
        {inSheet ? (
          <a href={PATHS.home} className={FOOT_LINK}>
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
            <kbd className="rounded-sm border border-border px-1 font-sans text-[0.6875rem]">
              {shortcutHint()}
            </kbd>
            {WB_SHELL_COPY.jump}
          </button>
          <button
            type="button"
            aria-label={WB_SHELL_COPY.shortcuts}
            onClick={() => {
              onNavigate?.();
              openShortcuts();
            }}
            className={cn(FOOT_LINK, 'w-8 justify-center px-0 pointer-coarse:w-11')}
          >
            <kbd className="font-sans text-xs">?</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
