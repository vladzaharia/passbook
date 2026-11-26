import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { hasDeveloperAccess } from '@/shared/spaces.ts';
import { wbPath } from '@/shared/workbench.ts';
import { useDocumentTitle } from '../../lib/route-focus.tsx';
import { useSession } from '../../lib/session.ts';
import { CARD_SURFACE } from '../../ui/card-base.tsx';
import { useWorkbenchContexts, type WbContext } from '../host/contexts.ts';
import { Monogram, TestLine } from '../shell/switcher-face.tsx';
import { NoSandboxState, NoWorkbenchAccess } from './states.tsx';

/** Several contexts and none remembered: pick one. The sandbox, if any, is first. */
function ContextChooser({ contexts }: { contexts: readonly WbContext[] }) {
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
            <Link
              to={wbPath(c.orgId, 'home')}
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
            </Link>
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
  if (list.length > 0) return <ContextChooser contexts={list} />;
  return authed && hasDeveloperAccess(authed.roles) ? <NoSandboxState /> : <NoWorkbenchAccess />;
}
