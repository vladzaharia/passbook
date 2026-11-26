import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_AREA, WB_SHELL_COPY, WB_TAB_TITLE } from '@/shared/copy/workbench-shell.ts';
import type { WbTool } from '@/shared/workbench.ts';
import { useDocumentTitle } from '../../lib/route-focus.tsx';
import { Button } from '../../ui/button.tsx';
import { SEEN_AREAS, type SeenArea } from '../host/summary.ts';
import { GlyphTile } from './area-button.tsx';
import { markSeen } from './attention.ts';
import { useWbShell } from './shell-context.ts';

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
  children: ReactNode;
}

/**
 * Every tool's frame (design §5.1, D2): the glyph tile beside the h1, a mono count, Mark seen while
 * the area has attention, then the one primary. Sections rise in, 45 ms apart.
 */
export function ToolPage({ tool, count, primary, toolbar, children }: ToolPageProps) {
  const { context, attention } = useWbShell();
  const { title } = WB_AREA[tool];
  useDocumentTitle(WB_TAB_TITLE[tool] ?? title);
  const area = isSeenArea(tool) && attention[tool] ? tool : null;
  return (
    <div className="wb-rise flex min-w-0 flex-col gap-4">
      <header className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        <GlyphTile tool={tool} />
        <h1
          tabIndex={-1}
          className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong outline-none"
        >
          {title}
        </h1>
        {count ? <span className="font-mono text-[0.8125rem] text-fg-muted">{count}</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {area && context ? (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Eye aria-hidden />}
              onClick={() => markSeen(context.orgId, area, Date.now())}
            >
              {WB_SHELL_COPY.markSeen}
            </Button>
          ) : null}
          {primary}
        </div>
      </header>
      {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
