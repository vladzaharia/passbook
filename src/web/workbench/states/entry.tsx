import { useRouter, useRouterState } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { hasDeveloperAccess } from '@/shared/spaces.ts';
import { type WbTool, wbPath, wbToolOf } from '@/shared/workbench.ts';
import { useDocumentTitle } from '../../lib/route-focus.tsx';
import { useSession } from '../../lib/session.ts';
import { CARD_SURFACE } from '../../ui/card-base.tsx';
import { keepTool, useWorkbenchContexts, type WbContext } from '../host/contexts.ts';
import { Monogram, TestLine } from '../shell/switcher-face.tsx';
import { NoSandboxState, NoWorkbenchAccess } from './states.tsx';

/** Several contexts and none remembered: pick one. The sandbox, if any, is first. */
function ContextChooser({
  contexts,
  tool,
  tail,
}: {
  contexts: readonly WbContext[];
  tool: WbTool;
  /** The query and hash the visit came with: they go through to the chosen context. */
  tail: string;
}) {
  const router = useRouter();
  useDocumentTitle(WB_STATES.chooser.title);
  return (
    <div className="wb-rise flex max-w-xl flex-col gap-4">
      <h1
        tabIndex={-1}
        className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong outline-none"
      >
        {WB_STATES.chooser.title}
      </h1>
      <ul className={`flex flex-col divide-y divide-border ${CARD_SURFACE}`}>
        {contexts.map((c) => (
          <li key={c.orgId}>
            <a
              href={`${wbPath(c.orgId, keepTool(c, tool))}${tail}`}
              onClick={(e) => {
                if (
                  e.defaultPrevented ||
                  e.button !== 0 ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                )
                  return;
                e.preventDefault();
                router.history.push(`${wbPath(c.orgId, keepTool(c, tool))}${tail}`);
              }}
              className="flex min-h-14 items-center gap-3 px-4 py-2.5 wl-colors hover:bg-state-hover-tint"
            >
              <Monogram name={c.name} className="size-8 text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-fg-strong">
                  {c.name}
                </span>
                <TestLine context={c} />
              </span>
              <ChevronRight aria-hidden className="size-4 text-fg-muted" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where a context-free path stays when it cannot pick a context (routes/workbench/index.tsx and
 * $tool.tsx redirect otherwise): the chooser, a developer's "No sandbox yet", or no access.
 */
export function WorkbenchEntry() {
  const { authed } = useSession();
  const contexts = useWorkbenchContexts();
  const list = contexts.data ?? [];
  const location = useRouterState({ select: (s) => s.location });
  const tool = wbToolOf(location.pathname) ?? 'home';
  const tail = `${location.searchStr}${location.hash ? `#${location.hash}` : ''}`;
  if (list.length > 0) return <ContextChooser contexts={list} tool={tool} tail={tail} />;
  return authed && hasDeveloperAccess(authed.roles) ? <NoSandboxState /> : <NoWorkbenchAccess />;
}
