import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { CHANGE_RUN_UNDO_MS, changeActionOf } from '@/shared/contracts/broadcasts-change.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { cancelBroadcastConfirm } from '../../../lib/confirms.ts';
import { changeUndoConfirm } from '../../../lib/confirms-change.ts';
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
  ErrorState,
  PageHeader,
  SkeletonDetail,
} from '../../../ui/index.ts';
import { ForbiddenPage } from '../../../ui/layout/error-pages.tsx';
import { broadcastQuery, useBroadcastActions } from '../../messages/api.ts';
import { RunProgress } from '../run-kit.tsx';
import { useChangeActions, useFollowRun } from './api.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { refusalText, runFailure } from './refusal.ts';
import { DoneCard, RunningCard, UndoBar } from './run-cards.tsx';
import { canChangePasses } from './selection.ts';

const ENDED = new Set(['sent', 'partial', 'failed', 'cancelled']);
/** A "Now" run is stored scheduled and started by the minute cron: it reads as starting, not booked. */
const START_GRACE_MS = 60_000;

/** One change run: running, done with its undo window, undone, or stopped with a resume. */
export function ChangeRunPage({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const orgId = !scope.isLoading && !scope.isError ? scope.orgId : undefined;
  const canManage = canChangePasses(scope.membership?.capabilities);
  const found = useQuery({
    ...broadcastQuery(runId),
    enabled: Boolean(orgId),
    // A run about to start polls like a running one; a far-off schedule waits.
    refetchInterval: (query) => {
      const run = query.state.data;
      if (run?.state === 'sending') return 2000;
      if (run?.state === 'scheduled')
        return (run.at ?? 0) - Date.now() <= START_GRACE_MS ? 2500 : 30_000;
      return false;
    },
  });
  const b = found.data;
  // A "Now" run waits for the minute cron: badge and card both say it is starting.
  const soon = b?.state === 'scheduled' && (b.at ?? 0) - Date.now() <= START_GRACE_MS;
  const mine = b && orgId && b.orgId === orgId && b.kind === 'change' && b.parentId === null;
  const ended = Boolean(b && ENDED.has(b.state));
  const undoRun = useFollowRun('parentId', runId, orgId ?? '', Boolean(mine && ended));
  const resumed = useFollowRun('retryOf', runId, orgId ?? '', Boolean(mine && ended));
  const actions = useChangeActions();
  const messages = useBroadcastActions();
  const [asking, setAsking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const list = orgId ? orgPath(orgId, '/passes') : '/admin/passes';
  const headerOf = (run: typeof b) => (
    <PageHeader
      title={C.run.title}
      breadcrumbs={[{ label: 'Passes', to: list }, { label: 'Change' }]}
      meta={
        run ? (
          <Badge
            tone={run.state === 'sent' ? 'success' : run.state === 'failed' ? 'danger' : 'neutral'}
          >
            {soon ? C.run.starting : (C.run.states[run.state] ?? run.state)}
          </Badge>
        ) : undefined
      }
    />
  );
  const header = headerOf(mine ? b : undefined);
  if (scope.isLoading) return <SkeletonDetail label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!orgId) return <OrgChooser />;
  if (!canManage) return <ForbiddenPage />;
  if (found.isError)
    return detailError(found, {
      entity: 'broadcast',
      noun: 'Change run',
      to: list,
      back: 'passes',
      header,
    });
  if (b && !mine)
    return (
      <>
        {header}
        <DetailNotFound entity="broadcast" noun="Change run" to={list} back="passes" />
      </>
    );
  if (!b) return <SkeletonDetail label="Loading the run" />;

  const action = changeActionOf(b.patch);
  const undoable = action !== 'design' && b.counts.updated > 0;
  const finished = b.finishedAt ?? b.createdAt;
  const deadline = finished + CHANGE_RUN_UNDO_MS;
  const open = deadline > Date.now();
  const undo = undoRun.data;
  const resumedRun = resumed.data;
  const remaining = Math.max(0, b.counts.targeted - b.counts.updated - b.counts.unchanged);
  const resumable =
    !undo &&
    !resumedRun &&
    remaining > 0 &&
    (b.state === 'partial' || b.state === 'failed' || b.state === 'cancelled') &&
    b.errorCode !== 'SELECTION_CHANGED';
  const why = b.state === 'failed' ? runFailure(b.errorCode) : null;

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setRefusal(null);
    try {
      return await work();
    } catch (error) {
      setRefusal(refusalText(error));
      return undefined;
    }
  }

  let body: React.ReactNode;
  if (soon || b.state === 'draft')
    body = soon ? (
      <RunningCard b={b} starting stopping={false} stopBusy={false} />
    ) : (
      <Callout tone="info">{C.run.notStarted}</Callout>
    );
  else if (b.state === 'scheduled')
    body = (
      <Callout
        tone="info"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setCancelling(true)}>
              {C.run.cancel}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to={list}>{C.run.toPasses}</Link>
            </Button>
          </>
        }
      >
        {C.run.scheduled(formatDateTime(b.at ?? 0))}
      </Callout>
    );
  else if (b.state === 'sending')
    body = (
      <RunningCard
        b={b}
        stopping={stopping}
        stopBusy={actions.stop.isPending}
        onStop={() =>
          void run(() => actions.stop.mutateAsync(b.id)).then((r) => r && setStopping(true))
        }
      />
    );
  else {
    const undone = undo?.state === 'sent';
    body = (
      <DoneCard b={b} undone={undone} undoing={undo?.state === 'sending'}>
        {undo ? (
          undo.state === 'sending' ? (
            <RunProgress
              done={undo.counts.updated + undo.counts.unchanged + undo.counts.failed}
              total={undo.counts.targeted}
              text={C.run.undoRunning(
                undo.counts.updated + undo.counts.unchanged + undo.counts.failed,
                undo.counts.targeted,
              )}
            />
          ) : (
            <div
              role="status"
              className="rounded-md border border-border bg-surface-sunken p-4 text-sm font-medium text-fg-strong"
            >
              {undone
                ? C.run.undone(undo.counts.updated, undo.counts.unchanged)
                : C.run.undoFailed(undo.counts.updated)}
            </div>
          )
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
        {why ? <Callout tone="danger">{why}</Callout> : null}
        {refusal ? <Callout tone="danger">{refusal}</Callout> : null}
        <div className="flex flex-wrap gap-2">
          {resumable ? (
            <Button
              iconStart={<RotateCcw aria-hidden />}
              loading={actions.resume.isPending}
              onClick={() =>
                void run(() =>
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
          {resumedRun ? (
            <Button asChild variant="outline">
              <Link to={orgPath(orgId, `/passes/change/${resumedRun.id}`)}>{C.run.resumedRun}</Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link to={list}>{C.run.toPasses}</Link>
          </Button>
        </div>
      </DoneCard>
    );
  }
  return (
    <>
      {header}
      {body}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        {...changeUndoConfirm(b.counts.updated)}
        destructive
        onConfirm={async () => {
          setAsking(false);
          await run(() => actions.undo.mutateAsync(b.id));
          await undoRun.refetch();
        }}
      />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        {...cancelBroadcastConfirm(b.name, 'change', b.state)}
        destructive
        onConfirm={async () => {
          setCancelling(false);
          await run(() => messages.cancel.mutateAsync(b.id));
        }}
      />
    </>
  );
}
