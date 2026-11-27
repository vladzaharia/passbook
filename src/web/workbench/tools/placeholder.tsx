import { Link } from '@tanstack/react-router';
import { WB_EMPTY } from '@/shared/copy/workbench-states.ts';
import { type WbTool, wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../ui/button.tsx';
import { STAGE_SURFACE } from '../../ui/empty-state.tsx';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty } from '../states/states.tsx';

/** Where an empty tool's action goes when it is plain navigation; the rest arrive with their tools. */
const NEXT: Partial<Record<WbTool, WbTool>> = { logs: 'console', passes: 'design' };

/**
 * An area's page until its package fills it (T1 to T8, DC2, DC3): the tool head and its empty
 * state from the one copy table, or the bare stage. Every route already has its place in the shell.
 */
export function ToolPlaceholder({ tool }: { tool: WbTool }) {
  const host = useOptionalToolHost();
  const next = NEXT[tool];
  const empty = WB_EMPTY[tool];
  return (
    <ToolPage tool={tool}>
      {empty ? (
        <ToolEmpty
          tool={tool}
          action={
            next && host && empty.action ? (
              <Button asChild variant="outline">
                <Link to={wbPath(host.context.orgId, next)}>{empty.action}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div aria-hidden className={cn('min-h-72', STAGE_SURFACE)} />
      )}
    </ToolPage>
  );
}
