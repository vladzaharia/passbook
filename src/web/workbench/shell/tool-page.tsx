import { Eye } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react';
import { POLL_PAUSED } from '@/shared/copy/workbench-poll.ts';
import { WB_AREA, WB_SHELL_COPY, WB_TAB_TITLE } from '@/shared/copy/workbench-shell.ts';
import type { WbTool } from '@/shared/workbench.ts';
import { useDocumentTitle } from '../../lib/route-focus.tsx';
import { usePollPaused } from '../../lib/use-poll-paused.ts';
import { Button } from '../../ui/button.tsx';
import { type BenchSlots, BenchSlotsContext } from '../bench/slots.tsx';
import { SEEN_AREAS, type SeenArea } from '../host/summary.ts';
import { useSandboxBusy } from '../sandbox/busy.ts';
import { GlyphTile } from './area-button.tsx';
import { markSeen } from './attention.ts';
import { useWbShell } from './shell-context.ts';

// Mid-reset (design §6): only a reset or start over under way loads this.
const Resetting = lazy(() =>
  import('../states/states.tsx').then((m) => ({ default: m.ResettingState })),
);

const isSeenArea = (tool: WbTool): tool is SeenArea =>
  (SEEN_AREAS as readonly string[]).includes(tool);

export interface ToolPageProps {
  tool: WbTool;
  /** A mono count after the title ("7 requests"), or the live state on phones. */
  count?: ReactNode;
  /** The view's one primary, at the head's end. */
  primary?: ReactNode;
  /** Filters and search, one row under the head. */
  toolbar?: ReactNode;
  /** False hides Mark seen where the view has nothing to mark (an empty feed). */
  markSeen?: boolean;
  children: ReactNode;
}

/**
 * Every tool's frame (design §5.1, D2): the glyph tile beside the h1, a mono count, Mark seen while
 * the area has attention, then the one primary. Sections rise in, 45 ms apart. The title keeps the
 * head's 40 px line, so a head that wraps its actions on a phone never moves the title.
 */
export function ToolPage({
  tool,
  count,
  primary,
  toolbar,
  markSeen: canMarkSeen = true,
  children,
}: ToolPageProps) {
  const { context, attention, seenAt } = useWbShell();
  const { title } = WB_AREA[tool];
  const [countEl, setCount] = useState<HTMLElement | null>(null);
  const [actionEl, setAction] = useState<HTMLElement | null>(null);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<HTMLElement | null>(null);
  const slots = useMemo<BenchSlots>(
    () => ({ count: countEl, action: actionEl, toolbar: bar, status }),
    [countEl, actionEl, bar, status],
  );
  useDocumentTitle(WB_TAB_TITLE[tool] ?? title);
  // Logs and Events say it in their own live mark.
  const limited = usePollPaused() && tool !== 'logs' && tool !== 'events';
  const area = isSeenArea(tool) && attention[tool] ? tool : null;
  // The Sandbox and Quickstart pages show their own operation.
  const resetting = useSandboxBusy(
    context?.kind === 'sandbox' && tool !== 'sandbox' && tool !== 'quickstart'
      ? context.orgId
      : undefined,
  );
  return (
    <div className="wb-rise flex min-w-0 flex-col gap-4">
      <header className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 max-sm:flex-nowrap">
        <GlyphTile tool={tool} />
        <h1
          tabIndex={-1}
          className="grid min-h-10 content-center text-2xl font-semibold tracking-[-0.015em] text-fg-strong outline-none"
        >
          {title}
        </h1>
        {count ? (
          <span className="min-w-0 truncate font-mono text-[0.8125rem] text-fg-muted">{count}</span>
        ) : null}
        <span
          ref={setCount}
          data-bench-count=""
          className="font-mono text-[0.8125rem] text-fg-muted empty:hidden"
        />
        <div ref={setStatus} data-bench-status="" className="empty:hidden" />
        {limited ? (
          <span role="status" className="text-[0.8125rem] text-fg-muted">
            {POLL_PAUSED}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {canMarkSeen && area && context && seenAt !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Eye aria-hidden />}
              onClick={() => markSeen(context.orgId, area, seenAt)}
            >
              {WB_SHELL_COPY.markSeen}
            </Button>
          ) : null}
          {primary}
          <div ref={setAction} className="contents" />
        </div>
      </header>
      <div
        ref={setBar}
        data-bench-toolbar=""
        className="flex flex-wrap items-center gap-2 empty:hidden"
      >
        {toolbar}
      </div>
      <div className="min-w-0">
        <BenchSlotsContext.Provider value={slots}>
          {resetting ? (
            <Suspense fallback={null}>
              <Resetting />
            </Suspense>
          ) : (
            children
          )}
        </BenchSlotsContext.Provider>
      </div>
    </div>
  );
}
