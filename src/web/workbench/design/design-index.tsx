import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { WB_EMPTY } from '@/shared/copy/workbench-states.ts';
import { pluralize } from '@/web/lib/format.ts';
import { templateKeys } from '../../admin/templates/keys.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { RowLink } from '../../ui/row-link.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';

const BlueprintPicker = lazy(() =>
  import('./blueprint-picker.tsx').then((m) => ({ default: m.BlueprintPicker })),
);

/** The context's own templates: a shared or platform one opens in admin, not here. */
function useOwnTemplates() {
  const api = useToolApi();
  const key = useToolKey();
  const { orgId } = useToolHost().context;
  const list = useQuery({
    queryKey: [...templateKeys.list({ orgId }), ...key],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, { query: { orgId, limit: 200 }, signal }),
  });
  const items = useMemo(
    () => (list.data?.items ?? []).filter((t) => t.orgId === orgId && t.status !== 'deleted'),
    [list.data, orgId],
  );
  return { list, items };
}

/**
 * Design's index (design §1.8): this context's templates, each opening the designer, and Start from
 * a blueprint, the one way to make the first. Admin's blueprint list and Use call are the source.
 */
export function DesignIndex() {
  const { orgId } = useToolHost().context;
  const { list, items } = useOwnTemplates();
  const [picking, setPicking] = useState(false);
  const start = (
    <Button variant={items.length === 0 ? 'primary' : 'outline'} onClick={() => setPicking(true)}>
      {WB_EMPTY.design?.action}
    </Button>
  );
  return (
    <ToolPage
      tool="design"
      count={items.length > 0 ? pluralize(items.length, 'template') : undefined}
      primary={items.length > 0 ? start : undefined}
    >
      {list.isError ? (
        <ToolFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <SkeletonRows rows={4} />
      ) : items.length === 0 ? (
        <ToolEmpty tool="design" action={start} />
      ) : (
        <ul
          aria-label="Templates"
          className="divide-y divide-border rounded-lg border border-border bg-surface-raised"
        >
          {items.map((t) => (
            <li key={t.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
              <RowLink
                to="/workbench/o/$orgId/design/$templateId"
                params={{ orgId, templateId: t.id }}
                inactive={t.status === 'archived'}
              >
                {t.name}
              </RowLink>
              {t.status === 'archived' ? <Badge>Archived</Badge> : null}
              {t.fromBlueprint ? (
                <span className="hidden truncate text-xs text-fg-muted sm:inline">
                  {t.fromBlueprint.name}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-[0.8125rem] text-fg-muted">
                {t.passCount} {t.passCount === 1 ? 'pass' : 'passes'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {picking ? (
        <Suspense fallback={null}>
          <BlueprintPicker open onOpenChange={setPicking} />
        </Suspense>
      ) : null}
    </ToolPage>
  );
}
