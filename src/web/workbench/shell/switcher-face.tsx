import { ChevronsUpDown } from 'lucide-react';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import type { WbTool } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import type { WbContext } from '../host/contexts.ts';

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

export const SWITCHER_TRIGGER =
  'flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-surface-page px-2 text-left wl-colors hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-12';

/** The switcher's face: monogram, name, the Test line, and what it does for a screen reader. */
export function SwitcherFace({ context }: { context: WbContext }) {
  return (
    <>
      <Monogram name={context.name} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm font-semibold text-fg-strong',
            context.kind === 'sandbox' && 'font-mono text-[0.8125rem] font-medium',
          )}
        >
          {context.name}
        </span>{' '}
        <TestLine context={context} />
        <span className="sr-only">, {WB_SHELL_COPY.switchContext}</span>
      </span>
      <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
    </>
  );
}

export interface ContextSwitcherProps {
  context: WbContext;
  contexts: readonly WbContext[];
  tool: WbTool | null;
  onNavigate?: () => void;
}
