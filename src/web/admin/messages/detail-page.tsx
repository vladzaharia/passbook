import { useNavigate } from '@tanstack/react-router';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cancelBroadcastConfirm } from '../../lib/confirms.ts';
import { formatCount, formatDateTime } from '../../lib/format.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  detailError,
  KeyValue,
  MetaLink,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
  toast,
} from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { useBroadcast, useBroadcastActions } from './api.ts';
import { clearLabel, KIND_LABEL, messageText, whenLine } from './labels.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { BroadcastProgress } from './progress.tsx';

const CRUMBS = [{ label: 'Messages', to: '/admin/messages' }];

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-fg-strong">{formatCount(value)}</dd>
      {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
    </div>
  );
}

function Counts({ b }: { b: BroadcastDto }) {
  const c = b.counts;
  const started = b.state !== 'draft' && b.state !== 'scheduled' && b.state !== 'cancelled';
  return (
    <Card>
      <CardHeader title="Progress" />
      <CardBody className="flex flex-col gap-4">
        {started ? <BroadcastProgress broadcast={b} /> : null}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Targeted" value={c.targeted} />
          <Stat label="Updated" value={c.updated} />
          <Stat label="Unchanged" value={c.unchanged} />
          <Stat
            label="Quiet"
            value={c.overBudget}
            hint={c.overBudget ? 'At the daily limit' : ''}
          />
          <Stat label="Failed" value={c.failed} />
        </dl>
        {!started ? (
          <p className="text-sm text-fg-muted">
            {b.state === 'cancelled'
              ? 'Cancelled before it started.'
              : 'Counts appear once it starts.'}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function MessageDetailPage({ broadcastId }: { broadcastId: string }) {
  const navigate = useNavigate();
  const query = useBroadcast(broadcastId);
  const { cancel } = useBroadcastActions();
  const orgs = useOrgOptions();
  const templates = useTemplates({ orgId: query.data?.orgId }, Boolean(query.data));
  const [asking, setAsking] = useState(false);

  if (query.isError)
    return detailError(query, {
      entity: 'broadcast',
      to: '/admin/messages',
      header: <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />,
    });
  if (!query.data)
    return (
      <>
        <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />
        <SkeletonDetail label="Loading message" />
      </>
    );
  const b = query.data;
  const org = orgs.data?.items.find((o) => o.id === b.orgId);
  const names = new Map((templates.data?.items ?? []).map((t) => [t.id, t.name]));
  const cancellable = b.state === 'draft' || b.state === 'scheduled';
  const text = messageText(b);

  return (
    <>
      <PageHeader
        title={b.name}
        breadcrumbs={[...CRUMBS, { label: b.name }]}
        meta={
          <>
            <StatusPill status={b.state} />
            <span>{KIND_LABEL[b.kind]}</span>
            <span>{whenLine(b)}</span>
            {b.parentId ? (
              <MetaLink to="/admin/messages/$broadcastId" params={{ broadcastId: b.parentId }}>
                Follow-up
              </MetaLink>
            ) : null}
          </>
        }
        actions={
          cancellable ? (
            <Button
              variant="outline"
              iconStart={<Ban aria-hidden />}
              onClick={() => setAsking(true)}
            >
              Cancel
            </Button>
          ) : undefined
        }
      />
      {b.errorCode ? (
        <Callout tone="danger" className="mb-6">
          {b.state === 'failed'
            ? 'It stopped before every pass was handled. Send it again to finish.'
            : 'Some passes could not be updated. Check the failed count.'}
        </Callout>
      ) : null}
      <TwoPane
        asideFrom="lg"
        asideLabel="Details"
        aside={
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KeyValue
                items={[
                  { label: 'Organization', value: org?.name ?? '—' },
                  {
                    label: 'Templates',
                    value: b.target.templateIds.map((id) => names.get(id) ?? id).join(', '),
                  },
                  {
                    label: 'Audience',
                    value:
                      [
                        b.target.onDevice ? 'On a device' : null,
                        b.target.holderState
                          ? { owned: 'Claimed', waiting: 'Not claimed', unassigned: 'No holder' }[
                              b.target.holderState
                            ]
                          : null,
                        b.target.q ? `Matching “${b.target.q}”` : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'Every active pass',
                  },
                  {
                    label: 'Notification',
                    value:
                      b.kind === 'message' && !text.trim()
                        ? 'None, clears the message'
                        : b.notify
                          ? 'Notify holders'
                          : 'Quiet',
                  },
                  ...(b.clearAfter ? [{ label: 'Clears', value: clearLabel(b.clearAfter) }] : []),
                  { label: 'Created', value: formatDateTime(b.createdAt) },
                  ...(b.startedAt
                    ? [{ label: 'Started', value: formatDateTime(b.startedAt) }]
                    : []),
                  ...(b.finishedAt
                    ? [{ label: 'Finished', value: formatDateTime(b.finishedAt) }]
                    : []),
                ]}
              />
            </CardBody>
          </Card>
        }
      >
        <Counts b={b} />
        {b.kind === 'message' ? (
          <Card>
            <CardHeader title="Message" />
            <CardBody>
              <LockScreenNotice
                org={{
                  id: b.orgId,
                  name: org?.name ?? 'Your organization',
                  accent: org?.branding.accent ?? null,
                }}
                text={text}
                silent={!b.notify || !text.trim()}
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Changes" />
            <CardBody>
              <KeyValue
                items={Object.entries(b.patch).map(([key, value]) => ({
                  label: key,
                  value: typeof value === 'string' ? value : JSON.stringify(value),
                }))}
              />
            </CardBody>
          </Card>
        )}
      </TwoPane>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        {...cancelBroadcastConfirm(b.name)}
        destructive
        onConfirm={async () => {
          await cancel.mutateAsync(b.id);
          toast.success('Message cancelled');
          void navigate({ to: '/admin/messages' });
        }}
      />
    </>
  );
}
