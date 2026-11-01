import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';
import { ComponentRow } from './component-row.tsx';
import { dataItems } from './data-items.ts';
import { groupComponents, problems, splitColumns } from './groups.ts';
import { sortBySeverity, useRecheck, useStatus } from './queries.ts';
import { Summary } from './summary.tsx';
import { WorkflowRuns } from './workflow-runs.tsx';

export function StatusPage() {
  const status = useStatus();
  const recheck = useRecheck();
  const [checks, setChecks] = useState(0);
  const orgs = useOrgList();
  const orgName = (id: string | null) => orgs.data?.items.find((o) => o.id === id)?.name;
  const data = status.data;
  const onRecheck = () =>
    recheck.mutate(undefined, {
      onSuccess: () => setChecks((n) => n + 1),
      onError: (cause) => toast.error(errorMessage(cause)),
    });
  return (
    <>
      <PageHeader title="Status" />
      {status.isPending ? (
        <SkeletonRows label="Loading status" />
      ) : status.isError || !data ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <Summary
            components={data.components}
            checkedAt={Math.max(0, ...data.components.map((c) => c.checkedAt))}
            checks={checks}
            rechecking={recheck.isPending}
            onRecheck={onRecheck}
          />
          {data.components.length === 0 ? (
            <Card>
              <EmptyState inline art="pulse" title="No components" />
            </Card>
          ) : (
            // Two columns at 1280 and up, split by row count so a card never changes sides.
            <div className="grid items-start gap-6 xl:grid-cols-2">
              {splitColumns(groupComponents(data.components)).map((column, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: always two columns
                <div key={i} className="flex min-w-0 flex-col gap-6">
                  {column.map((g) => {
                    const bad = problems(g.items).length;
                    return (
                      <section key={g.id} aria-labelledby={`g-${g.id}`}>
                        <Card className="overflow-hidden">
                          <CardHeader
                            title={<span id={`g-${g.id}`}>{g.title}</span>}
                            actions={
                              bad > 0 ? (
                                <span className="text-xs text-fg-muted">
                                  {bad} {bad === 1 ? 'needs' : 'need'} attention
                                </span>
                              ) : null
                            }
                          />
                          <ul aria-label={g.title} className="divide-y divide-border">
                            {sortBySeverity(g.items).map((c) => (
                              <ComponentRow
                                key={c.id}
                                component={c}
                                items={c.data ? dataItems(c.data, orgName) : []}
                              />
                            ))}
                          </ul>
                        </Card>
                      </section>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <WorkflowRuns orgName={orgName} />
        </div>
      )}
    </>
  );
}
