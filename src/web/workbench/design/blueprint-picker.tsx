import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { TemplateListSchema, type TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { entriesOf, groupEntries } from '../../admin/blueprints/gallery-model.ts';
import { templateKeys } from '../../admin/templates/keys.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { Button } from '../../ui/button.tsx';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolFailed } from '../states/states.tsx';
import { useStartFromBlueprint } from './blueprint-start.ts';

/** The platform's blueprints, the one list admin's gallery reads, on the Workbench token. */
function useBlueprintList(enabled: boolean) {
  const api = useToolApi();
  const key = useToolKey();
  const { orgId } = useToolHost().context;
  return useQuery({
    queryKey: [...templateKeys.list({ orgId, blueprint: true }), ...key],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, {
        query: { blueprint: true, orgId, limit: 200 },
        signal,
      }),
    enabled,
  });
}

/** Start from a blueprint: pick one, and Design opens on the copy that is now this context's. */
export function BlueprintPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const list = useBlueprintList(open);
  const start = useStartFromBlueprint();
  const groups = useMemo(() => groupEntries(entriesOf(list.data?.items ?? [])), [list.data]);
  const choose = (b: TemplateSummaryDto) => start.mutate(b);
  return (
    <Dialog open={open} onOpenChange={(o) => !start.isPending && onOpenChange(o)}>
      <DialogContent title={WB_DESIGN.index.pickTitle} size="md">
        <div className="max-h-[60dvh] overflow-y-auto px-5 py-4">
          {list.isError ? (
            <ToolFailed error={list.error} onRetry={() => void list.refetch()} />
          ) : list.isPending ? (
            <SkeletonRows rows={6} />
          ) : groups.length === 0 ? (
            <EmptyState inline art="template" title={WB_DESIGN.index.noBlueprints} />
          ) : (
            <div className="grid gap-5">
              {groups.map((g) => (
                <section key={g.id} aria-labelledby={`wb-bp-${g.id}`}>
                  <h3 id={`wb-bp-${g.id}`} className="mb-2 text-sm font-semibold text-fg-strong">
                    {g.label}
                  </h3>
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {g.entries
                      .flatMap((e) => e.variants.map((v) => v.blueprint))
                      .map((b) => (
                        <li key={b.id}>
                          <Button
                            variant="outline"
                            className="w-full justify-start"
                            disabled={start.isPending}
                            loading={start.isPending && start.variables?.id === b.id}
                            onClick={() => choose(b)}
                          >
                            <span className="truncate">{b.name}</span>
                          </Button>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
