import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { Callout } from '../../../../ui/callout.tsx';
import { namesBlueprint } from '../../../../workbench/design/anon/handoff.ts';
import { useToolHost } from '../../../../workbench/host/tool-host.tsx';
import { ToolPlaceholder } from '../../../../workbench/tools/placeholder.tsx';

const HandoffSave = lazy(() =>
  import('../../../../workbench/design/anon/handoff-save.tsx').then((m) => ({
    default: m.HandoffSave,
  })),
);

/** The sandbox's Design: a design handed off from the signed-out page is saved here first. */
function DesignIndex() {
  const host = useToolHost();
  const hash = useRouterState({ select: (s) => s.location.hash });
  if (host.context.kind === 'sandbox' && namesBlueprint(hash))
    return (
      <Suspense fallback={null}>
        <HandoffSave />
      </Suspense>
    );
  if (namesBlueprint(hash))
    return (
      <>
        <Callout className="mb-3" tone="info">
          {WB_DESIGN.anon.sandboxOnly}
        </Callout>
        <ToolPlaceholder tool="design" />
      </>
    );
  return <ToolPlaceholder tool="design" />;
}

export const Route = createFileRoute('/workbench/o/$orgId/design/')({
  component: DesignIndex,
});
