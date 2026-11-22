import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { CHANGE_RUN_UNDO_MS, changeActionOf } from '@/shared/contracts/broadcasts-change.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { orgPath } from '../../../lib/scope.ts';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DetailNotFound,
  detailError,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonDetail,
  toast,
} from '../../../ui/index.ts';
import { ForbiddenPage } from '../../../ui/layout/error-pages.tsx';
import { broadcastQuery, useChangeActions, useUndoRun } from './api.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { refusalText } from './refusal.ts';
import { DoneCard, RunningCard, UndoBar } from './run-cards.tsx';
import { canChangePasses } from './selection.ts';

const ENDED = new Set(['sent', 'partial', 'failed', 'cancelled']);

/** One change run: running, done with its undo window, undone, or stopped with a resume. */
export function ChangeRunPage({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const orgId = !scope.isLoading && !scope.isError ? scope.orgId : undefined;
  const canManage = canChangePasses(scope.membership?.capabilities);
  const found = useQuery({ ...broadcastQuery(runId), enabled: Boolean(orgId) });
  const b = found.data;
  const mine = b && orgId && b.orgId === orgId && b.kind === 'change' && b.parentId === null;
  const ended = Boolean(b && ENDED.has(b.state));
  const undoRun = useUndoRun(runId, orgId ?? '', Boolean(mine && ended));
  const actions = useChangeActions();
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const list = orgId ? orgPath(orgId, '/passes') : '/admin/passes';
  const header = (
    <PageHeader
      title={C.run.title}
      breadcrumbs={[{ label: 'Passes', to: list }, { label: 'Change' }]}
      meta={
        b ? (
          <Badge
            tone={b.state === 'sent' ? 'success' : b.state === 'failed' ? 'danger' : 'neutral'}
          >
            {C.run.states[b.state] ?? b.state}
          </Badge>
        ) : undefined
      }
    />
  );
  if (scope.isLoading) return <SkeletonDetail label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!orgId) return <EmptyState heading art="building" title="Choose an organization" />;
  if (!canManage) return <ForbiddenPage />;
  if (found.isError)
    return detailError(found, { entity: 'broadcast', to: list, back: 'Passes', header });
  if (b && !mine)
    return (
      <>
        {header}
        <DetailNotFound entity="broadcast" to={list} back="Passes" />
      </>
    );
  if (!b) return <SkeletonDetail label="Loading the run" />;

  const action = changeActionOf(b.patch);
  const undoable = action !== 'design' && b.counts.updated > 0;
  const finished = b.finishedAt ?? b.createdAt;
  const deadline = finished + CHANGE_RUN_UNDO_MS;
  const open = deadline > Date.now();
  const undo = undoRun.data;
  const remaining = Math.max(0, b.counts.targeted - b.counts.updated - b.counts.unchanged);
  const resumable =
    !undo &&
    remaining > 0 &&
    (b.state === 'partial' || b.state === 'failed' || b.state === 'cancelled') &&
    b.errorCode !== 'SELECTION_CHANGED';

  async function run<T>(verb: string, work: () => Promise<T>): Promise<T | undefined> {
    setRefusal(null);
    try {
      return await work();
    } catch (error) {
      setRefusal(refusalText(error));
      toast.error(error, C.run.couldNot(verb));
      return undefined;
    }
  }

  let body: React.ReactNode;
  if (b.state === 'draft' || b.state === 'scheduled')
    body = (
      <Callout tone="info">
        {b.at ? C.run.scheduled(formatDateTime(b.at)) : C.run.notStarted}
      </Callout>
    );
  else if (b.state === 'sending')
    body = (
      <RunningCard
        b={b}
        stopping={stopping}
        stopBusy={actions.stop.isPending}
        onStop={() =>
          void run('stop', () => actions.stop.mutateAsync(b.id)).then((r) => r && setStopping(true))
        }
      />
    );
  else
    body = (
      <DoneCard b={b} undone={Boolean(undo && undo.state !== 'sending')}>
        {undo ? (
          <p
            role="status"
            className="rounded-md border border-border bg-surface-sunken p-4 text-sm font-medium text-fg-strong"
          >
            {undo.state === 'sending' ? `${C.run.undoing}. ` : ''}
            {C.run.undone(
              undo.counts.updated,
              Math.max(0, b.counts.updated - undo.counts.updated - undo.counts.failed),
            )}
          </p>
        ) : action === 'design' ? (
          <p className="text-sm text-fg-muted">{C.run.notUndoable}</p>
        ) : undoable && open ? (
          <UndoBar
            until={formatDateTime(deadline)}
            busy={actions.undo.isPending}
            onUndo={() => setAsking(true)}
          />
        ) : undoable ? (
          <p className="text-sm text-fg-muted">{C.run.undoExpired}</p>
        ) : null}
        {b.errorCode === 'SELECTION_CHANGED' ? (
          <Callout tone="warning">{C.refusal.SELECTION_CHANGED}</Callout>
        ) : null}
        {refusal ? <Callout tone="danger">{refusal}</Callout> : null}
        <div className="flex flex-wrap gap-2">
          {resumable ? (
            <Button
              iconStart={<RotateCcw aria-hidden />}
              loading={actions.resume.isPending}
              onClick={() =>
                void run('resume', () =>
                  actions.resume.mutateAsync({ id: b.id, expectCount: remaining }),
                ).then(
                  (next) =>
                    next && void navigate({ href: orgPath(orgId, `/passes/change/${next.id}`) }),
                )
              }
            >
              {C.run.resumeLeft(remaining)}
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link to={list}>{C.run.toPasses}</Link>
          </Button>
        </div>
      </DoneCard>
    );
  return (
    <>
      {header}
      {body}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={C.run.undoConfirmTitle}
        description={C.run.undoConfirm(b.counts.updated)}
        confirmLabel={C.run.undo}
        destructive
        onConfirm={async () => {
          setAsking(false);
          await run('undo', () => actions.undo.mutateAsync(b.id));
          await undoRun.refetch();
        }}
      />
    </>
  );
}
