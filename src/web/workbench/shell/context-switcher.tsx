import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check, ChevronsUpDown } from 'lucide-react';
import { nowIn, WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { PATHS } from '@/shared/developers.ts';
import { type WbTool, wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu.tsx';
import { keepTool, type WbContext } from '../host/contexts.ts';
import { adminLink } from '../host/tool-host.tsx';
import { useAnnounce } from './announcer.tsx';

/** The org's monogram: neutral (strong text fill), so the view's primary stays its only accent. */
export function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6.5 shrink-0 place-items-center rounded-md bg-fg-strong text-xs font-semibold text-surface-page',
        className,
      )}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** "Sandbox · Test" or "Organization · Test": Test is info in a sandbox, warning in an org. */
export function TestLine({ context }: { context: WbContext }) {
  const sandbox = context.kind === 'sandbox';
  return (
    <span className="block truncate text-xs text-fg-muted">
      {sandbox ? WB_SHELL_COPY.sandbox : WB_SHELL_COPY.organization} ·{' '}
      <span className={cn('font-medium', sandbox ? 'text-info' : 'text-warning')}>
        {WB_SHELL_COPY.test}
      </span>
    </span>
  );
}

/**
 * The context switcher at the top of the sidebar and the sheet (design §2.1): the sandbox pinned
 * first, then orgs (the menu's own type-ahead finds one), then the ways out. Switching keeps the
 * area when the new context has it, else Home, drops the selection, and says where you are now.
 */
export function ContextSwitcher({
  context,
  contexts,
  tool,
  onNavigate,
}: {
  context: WbContext;
  contexts: readonly WbContext[];
  tool: WbTool | null;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const sandbox = context.kind === 'sandbox';
  const go = (target: WbContext) => {
    onNavigate?.();
    if (target.orgId === context.orgId) return;
    void navigate({ to: wbPath(target.orgId, keepTool(target, tool ?? 'home')) });
    announce(nowIn(target.name));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`${context.name}, ${WB_SHELL_COPY.switchContext}`}
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-surface-page px-2 text-left wl-colors hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-12"
      >
        <Monogram name={context.name} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-sm font-semibold text-fg-strong',
              sandbox && 'font-mono text-[0.8125rem] font-medium',
            )}
          >
            {context.name}
          </span>
          <TestLine context={context} />
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{WB_SHELL_COPY.switchGroup}</DropdownMenuLabel>
          {contexts.map((c) => (
            <DropdownMenuItem key={c.orgId} onSelect={() => go(c)} textValue={c.name}>
              <Monogram name={c.name} className="size-5 text-[0.625rem]" />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate',
                    c.kind === 'sandbox' && 'font-mono text-[0.8125rem]',
                  )}
                >
                  {c.name}
                </span>
                <TestLine context={c} />
              </span>
              {c.orgId === context.orgId ? <Check aria-hidden className="text-accent-fg!" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{WB_SHELL_COPY.goGroup}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <a href={adminLink(context.orgId)}>
              <ArrowUpRight aria-hidden />
              {WB_SHELL_COPY.openInAdmin}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={PATHS.home}>
              <BookOpen aria-hidden />
              {WB_SHELL_COPY.docs}
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
